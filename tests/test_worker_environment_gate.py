"""The local strategy runtime must fail closed before scheduler side effects."""

import sys
from pathlib import Path
from unittest.mock import ANY, Mock, call

import pytest
from veyra_api.config import Settings
from veyra_scheduler import __main__ as scheduler
from veyra_scheduler import worker as worker_module

DENIED_ENVIRONMENTS = ("production", "staging", "unknown", "LOCAL", "TEST",
                       "Local", "Test", "", " local", "test ")


def settings_for(app_env):
    return Settings(app_env=app_env, database_url="unused", object_store_dir=Path("unused"),
                    payment_webhook_secret="unused", job_lease_seconds=15,
                    quote_ttl_seconds=900, max_job_runtime_seconds=1800,
                    max_job_customer_usd="1.00")


@pytest.fixture(autouse=True)
def forbid_execution(monkeypatch):
    for target, name in ((worker_module.Worker, "claim"),
                         (worker_module.Worker, "execute"),
                         (worker_module, "StrategyProcess")):
        monkeypatch.setattr(target, name, Mock(side_effect=AssertionError("execution forbidden")))


@pytest.mark.parametrize("app_env", DENIED_ENVIRONMENTS)
def test_worker_rejects_other_environments_before_initialization(monkeypatch, app_env):
    database, store, hostname = Mock(), Mock(), Mock()
    monkeypatch.setattr(worker_module.socket, "gethostname", hostname)

    with pytest.raises(RuntimeError, match="requires APP_ENV=local or test"):
        worker_module.Worker(database, store, settings_for(app_env))

    assert database.mock_calls == store.mock_calls == hostname.mock_calls == []
    worker_module.Worker.claim.assert_not_called()
    worker_module.Worker.execute.assert_not_called()
    worker_module.StrategyProcess.assert_not_called()


@pytest.mark.parametrize("app_env", ("local", "test"))
@pytest.mark.parametrize("worker_id", (None, "fixture-worker"))
def test_worker_keeps_local_and_test_initialization(monkeypatch, app_env, worker_id):
    database, store, settings = Mock(), Mock(), settings_for(app_env)
    monkeypatch.setattr(worker_module.socket, "gethostname", lambda: "fixture-host")
    monkeypatch.setattr(worker_module.uuid, "uuid4", lambda: Mock(hex="123456789abcdef0"))

    worker = worker_module.Worker(database, store, settings, worker_id=worker_id)

    assert worker.db is database
    assert worker.store is store
    assert worker.settings is settings
    assert worker.worker_id == (worker_id or "fixture-host:12345678")
    assert database.mock_calls == store.mock_calls == []
    worker_module.Worker.claim.assert_not_called()
    worker_module.Worker.execute.assert_not_called()
    worker_module.StrategyProcess.assert_not_called()


@pytest.fixture
def cli_dependencies(monkeypatch):
    dependencies = Mock()
    for name in ("migrate", "Database", "ObjectStore", "Worker", "reap_expired"):
        replacement = Mock()
        monkeypatch.setattr(scheduler, name, replacement)
        dependencies.attach_mock(replacement, name)
    thread = Mock()
    monkeypatch.setattr(scheduler.threading, "Thread", thread)
    dependencies.attach_mock(thread, "Thread")
    monkeypatch.setattr(scheduler.config, "load", Mock())
    monkeypatch.setattr(scheduler.logging, "basicConfig", Mock())
    return dependencies


def set_cli(monkeypatch, app_env, mode):
    settings = settings_for(app_env)
    scheduler.config.load.return_value = settings
    argv = ["veyra-scheduler"] + ([mode] if mode else []) + ["--poll", "0.25"]
    monkeypatch.setattr(sys, "argv", argv)
    return settings


@pytest.mark.parametrize("app_env", DENIED_ENVIRONMENTS)
@pytest.mark.parametrize("mode", ("worker", "all", None))
def test_cli_rejects_before_any_scheduler_side_effect(
        monkeypatch, cli_dependencies, app_env, mode):
    set_cli(monkeypatch, app_env, mode)

    with pytest.raises(RuntimeError, match="requires APP_ENV=local or test"):
        scheduler.main()

    scheduler.config.load.assert_called_once_with()
    assert cli_dependencies.mock_calls == []


@pytest.mark.parametrize("app_env", ("local", "test"))
@pytest.mark.parametrize("mode", ("worker", "all", None))
def test_cli_keeps_local_and_test_wiring(monkeypatch, cli_dependencies, app_env, mode):
    settings = set_cli(monkeypatch, app_env, mode)

    scheduler.main()

    expected = [call.migrate(settings.database_url),
                call.Database(settings.database_url, max_size=4)]
    if mode != "worker":
        expected += [call.Thread(target=ANY, daemon=True), call.Thread().start()]
    expected += [call.ObjectStore(settings.object_store_dir),
                 call.Worker(cli_dependencies.Database.return_value,
                             cli_dependencies.ObjectStore.return_value, settings),
                 call.Worker().run_forever(0.25)]
    assert cli_dependencies.mock_calls == expected
    scheduler.config.load.assert_called_once_with()


@pytest.mark.parametrize("app_env", (*DENIED_ENVIRONMENTS, "local", "test"))
def test_reaper_only_remains_available_without_worker(
        monkeypatch, cli_dependencies, app_env):
    settings = set_cli(monkeypatch, app_env, "reaper")

    scheduler.main()

    assert cli_dependencies.mock_calls == [
        call.migrate(settings.database_url),
        call.Database(settings.database_url, max_size=4),
        call.Thread(target=ANY, daemon=True),
        call.Thread().start(),
        call.Thread().join(),
    ]
    scheduler.config.load.assert_called_once_with()
