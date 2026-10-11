from __future__ import annotations

import json
import logging
import math
import socket
import threading
import time
import uuid
from dataclasses import dataclass, field
from decimal import Decimal

from veyra_api.config import Settings
from veyra_api.db import Database
from veyra_api.settlement import RATE_CARDS, record_compute_usage, settle_job
from veyra_api.storage import ObjectStore
from veyra_sim import ENGINE_NAME, ENGINE_VERSION, data, engine, metrics, report
from veyra_sim.report import digest
from veyra_sim.sandbox import DeadlineExceeded, SandboxLimits, StrategyError, StrategyProcess

log = logging.getLogger("veyra.worker")


class LeaseLost(Exception):
    """Another actor (the reaper) took over this job; this worker must not write."""


@dataclass
class Claim:
    job: dict
    attempt_id: uuid.UUID
    fence: int
    lost: bool = False
    cancel_requested: bool = False
    progress: dict = field(default_factory=dict)


class Worker:
    def __init__(self, database: Database, store: ObjectStore, settings: Settings,
                 worker_id: str | None = None):
        self.db = database
        self.store = store
        self.settings = settings
        self.worker_id = worker_id or f"{socket.gethostname()}:{uuid.uuid4().hex[:8]}"

    # ------------------------------------------------------------------ claiming
    def claim(self, job_id: uuid.UUID | str | None = None) -> Claim | None:
        """Claim the oldest queued job (or a specific one, for targeted dispatch)."""
        where = "state = 'queued'" + (" AND id = %s" if job_id else "")
        with self.db.tx() as conn:
            row = conn.execute(f"SELECT id FROM jobs WHERE {where} ORDER BY created_at "
                               "FOR UPDATE SKIP LOCKED LIMIT 1",
                               (job_id,) if job_id else ()).fetchone()
            if row is None:
                return None
            job = conn.execute(
                "UPDATE jobs SET state = 'running', fence_token = fence_token + 1, "
                "version = version + 1, updated_at = now() WHERE id = %s RETURNING *",
                (row["id"],)).fetchone()
            n = conn.execute("SELECT count(*) + 1 AS n FROM job_attempts WHERE job_id = %s",
                             (job["id"],)).fetchone()["n"]
            attempt = conn.execute(
                "INSERT INTO job_attempts(job_id, attempt_no, fence_token, worker_id, "
                "lease_expires_at) VALUES (%s, %s, %s, %s, now() + make_interval(secs => %s)) "
                "RETURNING id", (job["id"], n, job["fence_token"], self.worker_id,
                                 self.settings.job_lease_seconds)).fetchone()
            conn.execute("INSERT INTO outbox(event_type, org_id, resource_id, resource_version) "
                         "VALUES ('job.started', %s, %s, %s)",
                         (job["org_id"], job["id"], job["version"]))
        return Claim(job, attempt["id"], job["fence_token"])

    def _heartbeat(self, claim: Claim) -> None:
        with self.db.tx() as conn:
            row = conn.execute(
                "UPDATE job_attempts a SET heartbeat_at = now(), "
                "lease_expires_at = now() + make_interval(secs => %s) FROM jobs j "
                "WHERE a.id = %s AND j.id = a.job_id AND j.fence_token = %s "
                "AND j.state = 'running' RETURNING j.cancel_requested",
                (self.settings.job_lease_seconds, claim.attempt_id, claim.fence)).fetchone()
            if row is None:
                claim.lost = True
                return
            claim.cancel_requested = row["cancel_requested"]
            conn.execute("UPDATE jobs SET progress = %s WHERE id = %s AND fence_token = %s",
                         (json.dumps(claim.progress), claim.job["id"], claim.fence))

    def _heartbeat_loop(self, claim: Claim, stop: threading.Event) -> None:
        interval = max(self.settings.job_lease_seconds / 3, 0.2)
        while not stop.wait(interval):
            try:
                self._heartbeat(claim)
            except Exception:  # transient DB error: lease may lapse; reaper decides
                log.exception("heartbeat failed for job %s", claim.job["id"])
            if claim.lost:
                return

    # ------------------------------------------------------------------ running
    def run_once(self, job_id: uuid.UUID | str | None = None) -> bool:
        claim = self.claim(job_id)
        if claim is None:
            return False
        try:
            self.execute(claim)
        except LeaseLost:
            log.warning("lease lost for job %s; discarding attempt output", claim.job["id"])
        return True

    def execute(self, claim: Claim) -> None:
        job = claim.job
        cfg = job["config"]
        started = time.monotonic()
        deadline = started + int(cfg["max_runtime_seconds"])
        stop = threading.Event()
        hb = threading.Thread(target=self._heartbeat_loop, args=(claim, stop), daemon=True)
        hb.start()
        sim = None
        outcome, error, platform_fault = "completed", None, False
        manifest, bars = {}, []
        try:
            files, manifest, bars, spec = self._prepare(job)
            limits = SandboxLimits(cpu_seconds=int(cfg["max_runtime_seconds"]) + 5)
            with StrategyProcess(files["files"], files["entrypoint"], limits) as proc:
                proc.deadline = deadline

                def should_stop() -> bool:
                    return claim.lost or claim.cancel_requested or time.monotonic() >= deadline

                def on_progress(done: int, total: int) -> None:
                    claim.progress = {"bars_done": done, "bars_total": total}

                model = engine.ExecutionModel(Decimal(str(cfg["taker_fee_bps"])),
                                              Decimal(str(cfg["slippage_bps"])))
                sim = engine.run(bars, spec.instrument, proc,
                                 starting_cash=Decimal(str(cfg["starting_cash"])),
                                 params=cfg["params"], model=model,
                                 should_stop=should_stop, on_progress=on_progress)
            if claim.lost:
                raise LeaseLost()
            if sim.stopped_early:
                outcome = "incomplete"
                error = ("cancelled by user" if claim.cancel_requested
                         else "authorized maximum runtime reached")
        except LeaseLost:
            stop.set()
            raise
        except DeadlineExceeded:
            outcome, error = "incomplete", "authorized maximum runtime reached"
        except StrategyError as e:
            outcome, error = "failed", f"strategy error: {str(e)[-1500:]}"
        except _PreconditionFailed as e:
            outcome, error, platform_fault = "failed", str(e), True
        except Exception:
            log.exception("internal error running job %s", job["id"])
            outcome, error, platform_fault = "failed", "internal platform error", True
        finally:
            stop.set()
            hb.join(timeout=5)

        elapsed = time.monotonic() - started
        rates = RATE_CARDS[cfg["rate_version"]]
        # Local model of supplier billing: wall time + provisioning overhead. Platform
        # faults are not billed to the customer. Production replaces this with the
        # supplier's reported task usage, reconciled later (spec §15.5).
        billed = 0 if platform_fault else math.ceil(elapsed) + rates.startup_overhead_seconds
        self._finish(claim, outcome, error, billed, sim, manifest, bars)

    def _prepare(self, job: dict):
        cfg = job["config"]
        with self.db.tx() as conn:
            pv = conn.execute("SELECT * FROM project_versions WHERE id = %s",
                              (job["project_version_id"],)).fetchone()
            quote = conn.execute("SELECT request FROM quotes WHERE id = %s",
                                 (cfg["quote_id"],)).fetchone()
        content = json.loads(self.store.get(pv["object_key"]))
        if digest(content) != pv["content_hash"]:
            raise _PreconditionFailed("code snapshot integrity check failed")
        bars = data.load(cfg["dataset_id"], cfg["start"], cfg["end"])
        spec = data.CATALOG[cfg["dataset_id"]]
        inputs = {"code": pv["content_hash"], "data": data.manifest_hash(bars),
                  "engine": f"{ENGINE_NAME}=={ENGINE_VERSION}", "rates": cfg["rate_version"],
                  "request": quote["request"]}
        if digest(inputs) != cfg["input_hash"]:
            raise _PreconditionFailed("inputs changed since the quote was authorized; requote")
        manifest = {
            "run_inputs_hash": cfg["input_hash"],
            "code": {"project_version_id": str(pv["id"]), "version_no": pv["version_no"],
                     "content_hash": pv["content_hash"], "entrypoint": pv["entrypoint"]},
            "dataset": {"dataset_id": spec.dataset_id, "provider": spec.provider,
                        "license": spec.license, "manifest_hash": inputs["data"],
                        "start": cfg["start"], "end": cfg["end"], "bars": len(bars)},
            "engine": inputs["engine"], "rate_version": cfg["rate_version"],
            "params": cfg["params"], "starting_cash": cfg["starting_cash"],
            "resource_class": cfg["resource_class"], "quote_id": cfg["quote_id"],
        }
        return content, manifest, bars, spec

    def _finish(self, claim, outcome, error, billed, sim, manifest, bars) -> None:
        job, cfg = claim.job, claim.job["config"]
        with self.db.tx() as conn:
            row = conn.execute("SELECT state, fence_token FROM jobs WHERE id = %s FOR UPDATE",
                               (job["id"],)).fetchone()
            if row["fence_token"] != claim.fence or row["state"] != "running":
                raise LeaseLost()
            conn.execute("UPDATE job_attempts SET ended_at = now(), end_reason = %s, "
                         "billed_seconds = %s WHERE id = %s",
                         (outcome, billed, claim.attempt_id))
            record_compute_usage(conn, org_id=job["org_id"], job_id=job["id"],
                                 attempt_id=claim.attempt_id,
                                 resource_class=cfg["resource_class"],
                                 rate_version=cfg["rate_version"], billed_seconds=billed,
                                 detail={"worker_id": self.worker_id, "basis": "local-wall"})
            receipt = settle_job(conn, job["id"], outcome, error=error)
            if sim is not None and outcome in ("completed", "incomplete"):
                self._write_report(conn, job, outcome, sim, manifest, receipt, bars)

    def _write_report(self, conn, job, outcome, sim, manifest, receipt, bars) -> None:
        cfg = job["config"]
        m = metrics.compute(sim.equity, Decimal(str(cfg["starting_cash"])), sim.fills,
                            sim.positions)
        model = engine.ExecutionModel(Decimal(str(cfg["taker_fee_bps"])),
                                      Decimal(str(cfg["slippage_bps"]))).describe()
        rep = report.build(run_id=str(job["id"]), outcome=outcome, manifest=manifest, metrics=m,
                           sim=sim, model=model, quality=data.quality_findings(bars),
                           receipt=receipt)
        prefix = f"orgs/{job['org_id']}/runs/{job['id']}"
        artifacts = {}
        for name, body in (("report.json", json.dumps(rep, indent=2, default=str)),
                           ("report.html", report.render_html(rep)),
                           ("trades.csv", report.trades_csv(rep))):
            key = f"{prefix}/{name}"
            artifacts[name] = {"key": key, "sha256": self.store.put(key, body.encode()),
                               "bytes": len(body.encode())}
        conn.execute("INSERT INTO reports(org_id, job_id, outcome, result_digest, metrics, "
                     "artifacts) VALUES (%s,%s,%s,%s,%s,%s)",
                     (job["org_id"], job["id"], outcome, rep["result_digest"], json.dumps(m),
                      json.dumps(artifacts)))

    def run_forever(self, poll_seconds: float = 1.0) -> None:
        log.info("worker %s started", self.worker_id)
        while True:
            if not self.run_once():
                time.sleep(poll_seconds)


class _PreconditionFailed(Exception):
    pass
