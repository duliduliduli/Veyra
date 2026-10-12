"""Stale discovery regressions using SQL/transaction doubles, not PostgreSQL proof."""

import copy
import logging
import math
from contextlib import contextmanager
from datetime import timedelta
from uuid import UUID

import pytest
from test_held_record_resilience_unit import STAMP, MemoryDatabase, hold, record
from test_held_record_resilience_unit import ledger as ledger
from veyra_billing import RATE_CARD_V1
from veyra_scheduler import reaper

REFRESH = "SELECT id, started_at, heartbeat_at FROM job_attempts"


def expired_record(number):
    row = record(number)
    row["attempt"].update(started_at=STAMP - timedelta(seconds=10),
                          heartbeat_at=STAMP - timedelta(seconds=7.8))
    row["job"]["created_at"] = row["auth"]["created_at"] = (
        STAMP - timedelta(seconds=1000 - number))
    return row


class RefreshDatabase(MemoryDatabase):
    """Return an old discovery join and current rows on the separate refresh read."""

    def __init__(self, rows):
        super().__init__(rows)
        self.discovery = {row["job"]["id"]: copy.deepcopy(row["attempt"]) for row in rows}
        self.fail_query = self.fail_commit = self.before_commit = None

    def execute(self, sql, params=()):
        if self.fail_query and sql.startswith(self.fail_query):
            raise RuntimeError("synthetic query failure")
        if not sql.startswith("SELECT j.*"):
            return super().execute(sql, params)
        current = [row["attempt"] for row in self.pending]
        try:
            for row in self.pending:
                row["attempt"] = self.discovery[row["job"]["id"]]
            return super().execute(sql, params)
        finally:
            for row, attempt in zip(self.pending, current, strict=True):
                row["attempt"] = attempt

    @contextmanager
    def tx(self):
        with super().tx() as conn:
            yield conn
            if self.before_commit:
                self.before_commit()
            if self.fail_commit:
                raise self.fail_commit("synthetic commit failure")


def position(row):
    return row["job"]["created_at"], row["job"]["id"]


@pytest.mark.parametrize("invalid", [
    "renewed", "expiry_equal", "ended", "missing", "attempt_id", "job_id", "fence",
])
def test_stale_selected_attempt_is_noop_before_auth_or_any_write(ledger, caplog, invalid):
    db, cursor = RefreshDatabase([expired_record(1)]), reaper.ReapCursor()
    attempt = db.rows[0]["attempt"]
    if invalid == "missing":
        db.rows[0]["attempt"] = None
    else:
        key, value = {
            "renewed": ("lease_expires_at", STAMP + timedelta(seconds=60)),
            "expiry_equal": ("lease_expires_at", STAMP),
            "ended": ("ended_at", STAMP),
            "attempt_id": ("id", UUID(int=999)),
            "job_id": ("job_id", UUID(int=999)),
            "fence": ("fence_token", 0),
        }[invalid]
        attempt[key] = value
    before = copy.deepcopy(db.rows)
    with caplog.at_level(logging.WARNING, logger="veyra.reaper"):
        assert reaper.reap_expired(db, batch_size=1, cursor=cursor) == []
    assert db.rows == before
    assert db.events == [("commit", before[0]["job"]["id"], None)]
    assert cursor.after == position(before[0])
    assert len(db.statements) == 2
    assert db.statements[1][0].startswith(REFRESH)
    assert db.statements[1][1] == (
        db.discovery[before[0]["job"]["id"]]["id"], before[0]["job"]["id"], 1)
    assert all(sql.startswith("SELECT ") for sql, _ in db.statements)
    assert not caplog.records
    ledger.assert_not_called()


@pytest.mark.parametrize("started,heartbeat", [(-20, -7.8), (-10, -2.2), (-20, -2.2)])
def test_recovery_bills_only_refreshed_started_and_heartbeat_values(ledger, started, heartbeat):
    row = expired_record(1)
    db = RefreshDatabase([row])
    db.rows[0]["attempt"].update(started_at=STAMP + timedelta(seconds=started),
                                 heartbeat_at=STAMP + timedelta(seconds=heartbeat))
    current = db.rows[0]["attempt"]
    assert current["started_at"] < current["heartbeat_at"] < current["lease_expires_at"] < STAMP
    assert reaper.reap_expired(db, batch_size=1) == [str(row["job"]["id"])]
    billed = math.ceil(heartbeat - started) + RATE_CARD_V1.startup_overhead_seconds
    assert billed != 3 + RATE_CARD_V1.startup_overhead_seconds
    assert db.rows[0]["attempt"]["billed_seconds"] == billed
    assert db.rows[0]["usage"][0]["units"] == billed
    assert db.rows[0]["usage"][0]["detail"]["basis"] == "heartbeat-proven"
    assert db.rows[0]["job"]["fence_token"] == 2
    assert db.rows[0]["auth"]["status"] == "settled"
    ledger.assert_called_once()


@pytest.mark.parametrize("batch_size", [1, 4])
def test_noops_holds_and_healthy_records_consume_visits_then_resume_and_wrap(ledger, batch_size):
    rows = [expired_record(i) for i in range(1, 5)]
    hold(rows[1], "ceiling")
    db, cursor = RefreshDatabase(rows), reaper.ReapCursor()
    for index in (0, 3):
        db.rows[index]["attempt"]["lease_expires_at"] = STAMP + timedelta(seconds=60)
    before = copy.deepcopy(db.rows)
    recovered = []
    for _ in range(4 // batch_size):
        recovered += reaper.reap_expired(db, batch_size=batch_size, cursor=cursor)
    assert recovered == [str(rows[2]["job"]["id"])]
    assert db.selected == [row["job"]["id"] for row in rows]
    selections = [params[0] for sql, params in db.statements if sql.startswith("SELECT j.*")]
    assert selections == [db.selected[index - index % batch_size:index] for index in range(4)]
    assert cursor.after == position(rows[-1])
    assert [event[0] for event in db.events] == ["commit", "rollback", "commit", "commit"]
    for index in (0, 1, 3):
        assert db.rows[index] == before[index]
    ledger.assert_called_once()
    assert reaper.reap_expired(db, batch_size=1, cursor=cursor) == []
    assert cursor.after is None
    # Once a previously renewed attempt expires, a later scan revisits it.
    db.rows[0]["attempt"]["lease_expires_at"] = STAMP - timedelta(seconds=1)
    assert reaper.reap_expired(db, batch_size=1, cursor=cursor) == [str(rows[0]["job"]["id"])]
    assert cursor.after == position(rows[0])
    assert ledger.call_count == 2


def test_noop_prefix_cannot_starve_healthy_record_beyond_batch_limit(ledger):
    rows = [expired_record(i) for i in range(1, 102)]
    db, cursor = RefreshDatabase(rows), reaper.ReapCursor()
    for row in db.rows[:-1]:
        row["attempt"]["lease_expires_at"] = STAMP + timedelta(seconds=60)
    before = copy.deepcopy(db.rows)
    assert reaper.reap_expired(db, cursor=cursor) == []
    assert len(db.selected) == 100
    assert cursor.after == position(rows[99])
    assert db.rows == before
    ledger.assert_not_called()
    assert reaper.reap_expired(db, cursor=cursor) == [str(rows[-1]["job"]["id"])]
    assert len(db.selected) == 101 and cursor.after is None
    ledger.assert_called_once()


@pytest.mark.parametrize("state", ["noop", "recovery", "no_candidate"])
@pytest.mark.parametrize("error", [RuntimeError, KeyboardInterrupt])
def test_commit_failure_keeps_prior_cursor_and_reports_no_recovery(
        ledger, caplog, state, error):
    db = RefreshDatabase([expired_record(1)])
    cursor = reaper.ReapCursor(after=position(expired_record(0)))
    if state == "noop":
        db.rows[0]["attempt"]["lease_expires_at"] = STAMP + timedelta(seconds=60)
    elif state == "no_candidate":
        db.rows[0]["job"]["state"] = "settled"
    before, prior = copy.deepcopy(db.rows), cursor.after
    db.fail_commit = error
    observed = []

    def before_commit():
        assert cursor.after == prior
        assert not caplog.records
        observed.append(True)

    db.before_commit = before_commit
    with caplog.at_level(logging.WARNING, logger="veyra.reaper"), pytest.raises(error):
        reaper.reap_expired(db, batch_size=1, cursor=cursor)
    assert observed == [True]
    assert db.rows == before and cursor.after == prior
    assert db.events[-1][0] == "rollback"
    assert not caplog.records
    if state != "recovery":
        ledger.assert_not_called()
    db.fail_commit = db.before_commit = None
    result = reaper.reap_expired(db, batch_size=1, cursor=cursor)
    assert result == ([str(before[0]["job"]["id"])] if state == "recovery" else [])
    assert cursor.after == (None if state == "no_candidate" else position(before[0]))
    if state == "recovery":
        # The first mocked posting was pending in the rolled-back transaction only.
        assert len(db.rows[0]["postings"]) == 1


def test_refresh_failure_rolls_back_without_advancing_past_selected_job(ledger):
    db, cursor = RefreshDatabase([expired_record(1), expired_record(2)]), reaper.ReapCursor()
    before = copy.deepcopy(db.rows)
    db.fail_query = REFRESH
    with pytest.raises(RuntimeError, match="synthetic query failure"):
        reaper.reap_expired(db, cursor=cursor)
    assert cursor.after is None and db.rows == before
    assert len(db.statements) == 1
    assert db.events[-1][0] == "rollback"
    ledger.assert_not_called()
    db.fail_query = None
    assert reaper.reap_expired(db, cursor=cursor) == [str(row["job"]["id"]) for row in before]
    assert db.selected == [before[index]["job"]["id"] for index in (0, 0, 1)]
    assert ledger.call_count == 2
