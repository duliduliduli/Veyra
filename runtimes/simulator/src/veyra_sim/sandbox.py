"""Run untrusted strategy code in a separate, resource-limited OS process.

LOCAL/DEV BOUNDARY ONLY. A separate process stops the strategy from touching the
simulator's memory (clock, fills, ledger, future bars), but it still shares the host
filesystem and network. Production must run this in its own Fargate task / Modal
sandbox with no dataset mounted and egress denied (spec §5.3, §18.2). See ADR 0002.
"""

from __future__ import annotations

import json
import os
import queue
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path


class StrategyError(RuntimeError):
    """The strategy crashed, misbehaved, or exceeded a limit."""


class DeadlineExceeded(StrategyError):
    """The job's authorized runtime ran out while waiting on the strategy."""


@dataclass(frozen=True)
class SandboxLimits:
    cpu_seconds: int = 300
    memory_bytes: int = 1024 * 1024 * 1024
    max_file_bytes: int = 16 * 1024 * 1024
    message_timeout_s: float = 10.0
    max_message_bytes: int = 64 * 1024


def _child_setup(limits: SandboxLimits):
    def setup() -> None:
        os.setsid()
        # Die with the parent so a crashed worker cannot leak an orphan (spec §10.2).
        try:
            import ctypes

            libc = ctypes.CDLL("libc.so.6", use_errno=True)
            libc.prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG
        except OSError:
            pass
        resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds))
        resource.setrlimit(resource.RLIMIT_AS, (limits.memory_bytes, limits.memory_bytes))
        resource.setrlimit(resource.RLIMIT_FSIZE, (limits.max_file_bytes,) * 2)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    return setup


class StrategyProcess:
    def __init__(self, files: dict[str, str], entrypoint: str, limits: SandboxLimits):
        self.limits = limits
        self.deadline: float | None = None  # time.monotonic() value set by the runner
        self.workdir = Path(tempfile.mkdtemp(prefix="veyra-strategy-"))
        for rel, content in files.items():
            target = (self.workdir / rel).resolve()
            if not target.is_relative_to(self.workdir):
                raise StrategyError(f"illegal path {rel!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        entry = (self.workdir / entrypoint).resolve()
        if not entry.is_relative_to(self.workdir) or not entry.is_file():
            raise StrategyError(f"entrypoint {entrypoint!r} not found")
        env = {"PATH": "/usr/bin:/bin", "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1",
               "HOME": str(self.workdir), "LANG": "C.UTF-8"}
        self.proc = subprocess.Popen(
            [sys.executable, "-I", "-m", "veyra_sdk.host", str(entry)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=self.workdir, env=env, text=True, bufsize=1,
            preexec_fn=_child_setup(limits),  # noqa: PLW1509 - required for rlimits
        )
        self._out: queue.Queue[str | None] = queue.Queue()
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self.proc.stdout
        for line in self.proc.stdout:
            self._out.put(line)
        self._out.put(None)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr
        # shortcut: strategy prints are drained and dropped, surface them once IDE logs exist
        for _ in self.proc.stderr:
            pass

    def request(self, msg: dict) -> dict:
        try:
            assert self.proc.stdin
            self.proc.stdin.write(json.dumps(msg, separators=(",", ":")) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise StrategyError(f"strategy process exited: {self._exit_reason()}") from e
        timeout = self.limits.message_timeout_s
        if self.deadline is not None:
            timeout = min(timeout, self.deadline - time.monotonic())
            if timeout <= 0:
                raise DeadlineExceeded("authorized runtime exhausted")
        try:
            line = self._out.get(timeout=timeout)
        except queue.Empty:
            if self.deadline is not None and time.monotonic() >= self.deadline:
                raise DeadlineExceeded("authorized runtime exhausted") from None
            raise StrategyError(
                f"strategy did not respond within {self.limits.message_timeout_s}s") from None
        if line is None:
            raise StrategyError(f"strategy process exited: {self._exit_reason()}")
        if len(line) > self.limits.max_message_bytes:
            raise StrategyError("strategy reply exceeded size limit")
        try:
            reply = json.loads(line)
        except ValueError:
            raise StrategyError("strategy sent a malformed protocol message") from None
        if not isinstance(reply, dict):
            raise StrategyError("strategy sent a malformed protocol message")
        if reply.get("type") == "error":
            raise StrategyError(reply.get("message", "strategy error"))
        return reply

    def _exit_reason(self) -> str:
        code = self.proc.poll()
        if code is None:
            try:
                code = self.proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                return "unresponsive"
        if code < 0:
            return f"killed by signal {signal.Signals(-code).name}"
        return f"exit code {code}"

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.proc.wait(timeout=5)
        shutil.rmtree(self.workdir, ignore_errors=True)

    def __enter__(self) -> StrategyProcess:
        return self

    def __exit__(self, *exc) -> None:
        self.close()
