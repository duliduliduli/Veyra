"""Exercise the captured scheduler loop without threads, storage or database work."""

import logging
from types import SimpleNamespace
from unittest.mock import ANY, Mock, call

import pytest
from veyra_scheduler import __main__ as scheduler


class StopLoop(BaseException):
    pass


@pytest.fixture
def reaper_loop(monkeypatch):
    settings = SimpleNamespace(database_url="unused", job_lease_seconds=8)
    monkeypatch.setattr(scheduler.config, "load", lambda: settings)
    monkeypatch.setattr("sys.argv", ["veyra-scheduler", "reaper"])
    dependencies = Mock()
    for name in ("migrate", "Database", "ObjectStore", "Worker", "reap_expired",
                 "reap_unused_authorizations"):
        replacement = Mock()
        monkeypatch.setattr(scheduler, name, replacement)
        dependencies.attach_mock(replacement, name)
    thread = Mock()
    monkeypatch.setattr(scheduler.threading, "Thread", thread)
    sleep = Mock(side_effect=StopLoop)
    monkeypatch.setattr(scheduler.time, "sleep", sleep)
    dependencies.attach_mock(sleep, "sleep")
    scheduler.main()
    assert thread.call_args.kwargs["daemon"] is True
    thread.return_value.start.assert_called_once_with()
    thread.return_value.join.assert_called_once_with()
    dependencies.reset_mock()
    yield thread.call_args.kwargs["target"], dependencies, settings
    scheduler.Worker.assert_not_called()
    scheduler.ObjectStore.assert_not_called()
    scheduler.Database.return_value.assert_not_called()
    assert scheduler.Database.return_value.mock_calls == []


@pytest.mark.parametrize("failed_paths", [(), ("reap_expired",),
                                        ("reap_unused_authorizations",),
                                        ("reap_expired", "reap_unused_authorizations")])
def test_failures_allow_both_paths_to_retry_on_next_interval(reaper_loop, caplog, failed_paths):
    target, dependencies, _ = reaper_loop
    for name in failed_paths:
        getattr(dependencies, name).side_effect = [RuntimeError("secret config"), []]
    dependencies.sleep.side_effect = [None, StopLoop]

    with caplog.at_level(logging.ERROR, logger="veyra.reaper"), pytest.raises(StopLoop):
        target()

    database = scheduler.Database.return_value
    assert dependencies.mock_calls == [
        call.reap_expired(database, cursor=ANY),
        call.reap_unused_authorizations(database, cursor=ANY), call.sleep(4),
    ] * 2
    assert len(caplog.records) == len(failed_paths)
    for name, record in zip(failed_paths, caplog.records, strict=True):
        assert record.name == "veyra.reaper"
        assert record.levelno == logging.ERROR
        assert record.getMessage() == f"{name} failed (RuntimeError); retrying next interval"
        assert record.exc_info is None
        assert record.stack_info is None
    assert "secret config" not in caplog.text


@pytest.mark.parametrize("lease_seconds, interval", [(0, 1), (1, 1), (3, 1.5), (20, 10)])
def test_persistent_failures_sleep_once_per_pass(reaper_loop, lease_seconds, interval):
    target, dependencies, settings = reaper_loop
    settings.job_lease_seconds = lease_seconds
    dependencies.reap_expired.side_effect = RuntimeError("unavailable")
    dependencies.reap_unused_authorizations.side_effect = ValueError("unavailable")
    dependencies.sleep.side_effect = [None, None, StopLoop]

    with pytest.raises(StopLoop):
        target()

    database = scheduler.Database.return_value
    assert dependencies.mock_calls == [
        call.reap_expired(database, cursor=ANY),
        call.reap_unused_authorizations(database, cursor=ANY),
        call.sleep(interval),
    ] * 3


@pytest.mark.parametrize("failed_path", ["reap_expired", "reap_unused_authorizations"])
@pytest.mark.parametrize("error", [KeyboardInterrupt, SystemExit, GeneratorExit])
def test_process_level_exceptions_propagate(reaper_loop, caplog, failed_path, error):
    target, dependencies, _ = reaper_loop
    getattr(dependencies, failed_path).side_effect = error

    with pytest.raises(error):
        target()

    expected = [call.reap_expired(scheduler.Database.return_value, cursor=ANY)]
    if failed_path == "reap_unused_authorizations":
        expected.append(call.reap_unused_authorizations(
            scheduler.Database.return_value, cursor=ANY))
    assert dependencies.mock_calls == expected
    assert caplog.records == []


def test_scan_cursors_persist_per_path_across_loop_failures(reaper_loop):
    target, dependencies, _ = reaper_loop
    seen = {"active": [], "unused": []}

    def observe(path):
        def reap(database, *, cursor):
            seen[path].append(cursor)
            cursor.after = (path, len(seen[path]))
            if len(seen[path]) == 1:
                raise RuntimeError("retry after partial progress")
        return reap

    dependencies.reap_expired.side_effect = observe("active")
    dependencies.reap_unused_authorizations.side_effect = observe("unused")
    dependencies.sleep.side_effect = [None, StopLoop]
    with pytest.raises(StopLoop):
        target()
    assert seen["active"][0] is seen["active"][1]
    assert seen["unused"][0] is seen["unused"][1]
    assert seen["active"][0] is not seen["unused"][0]
    assert seen["active"][0].after == ("active", 2)
    assert seen["unused"][0].after == ("unused", 2)
