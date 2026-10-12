"""Only tiny, explicitly trusted fixtures run here; process launches are mocked."""

import importlib
import io
import sys
from unittest.mock import Mock

import pytest
from veyra_sdk import Strategy
from veyra_sdk.host import _load_strategy
from veyra_sim import sandbox

ENTRY = "from veyra_sdk import Strategy\nclass Example(Strategy):\n    value = 7\n"
HELPER_BASE = "from veyra_sdk import Strategy\nclass Base(Strategy):\n    pass\n"


@pytest.fixture(autouse=True)
def isolate_import_state():
    paths, modules = sys.path[:], sys.modules.copy()
    yield
    sys.path[:] = paths
    for name in set(sys.modules) - modules.keys():
        del sys.modules[name]
    sys.modules.update(modules)
    importlib.invalidate_caches()


def snapshot(tmp_path, files):
    root = tmp_path / "snapshot"
    root.mkdir()
    for name, source in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.encode("utf-8"))
    return root


def load(root, entrypoint="main.py"):
    before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*.py")}
    strategy = _load_strategy(str(root / entrypoint), root)
    assert {p.relative_to(root): p.read_bytes() for p in root.rglob("*.py")} == before
    return strategy


@pytest.mark.parametrize("entrypoint", ("main.py", "main-strategy.py", "123.py", "class.py",
                                       "scripts/main.py", "bad-name/main.py",
                                       "class/main.py", "123/main.py", "pkg/main-strategy.py"))
def test_absolute_helpers_resolve_from_snapshot_root_only(tmp_path, entrypoint):
    root = snapshot(tmp_path, {
        entrypoint: "from veyra_fixture_helper import VALUE\n" + ENTRY.replace("7", "VALUE"),
        "veyra_fixture_helper.py": "VALUE = 23\n",
        "scripts/veyra_fixture_helper.py": "VALUE = 99\n",
    })
    original = sys.path[:]
    strategy = load(root, entrypoint)
    assert strategy.value == 23
    assert sys.path == [*original, str(root)]


def test_nested_entry_does_not_implicitly_add_its_directory(tmp_path):
    root = snapshot(tmp_path, {
        "scripts/main.py": "import veyra_nested_only_helper\n" + ENTRY,
        "scripts/veyra_nested_only_helper.py": "VALUE = 7\n",
    })
    with pytest.raises(ModuleNotFoundError, match="veyra_nested_only_helper"):
        load(root, "scripts/main.py")


@pytest.mark.parametrize("entrypoint", ("veyra_fixture_pkg/main.py",
                                       "veyra_fixture_pkg/__init__.py"))
def test_relative_imports_in_explicit_packages(tmp_path, entrypoint):
    root = snapshot(tmp_path, {
        "veyra_fixture_pkg/__init__.py": "LABEL = 'package'\n",
        "veyra_fixture_pkg/helper.py": "VALUE = 31\n",
        entrypoint: "from .helper import VALUE\n" + ENTRY.replace("7", "VALUE"),
    })
    strategy = load(root, entrypoint)
    assert strategy.value == 31
    assert type(strategy).__module__ == ("veyra_fixture_pkg" if entrypoint.endswith("__init__.py")
                                         else "veyra_fixture_pkg.main")


def test_deep_package_parents_and_lazy_imports(tmp_path):
    root = snapshot(tmp_path, {
        "veyra_fixture_pkg/__init__.py": "LABEL = 'outer'\n",
        "veyra_fixture_pkg/helper.py": "VALUE = 37\n",
        "veyra_fixture_pkg/nested/__init__.py": "LABEL = 'inner'\n",
        "veyra_fixture_pkg/nested/main.py": (
            "from veyra_sdk import Strategy\nclass Example(Strategy):\n"
            "    def answer(self):\n        from ..helper import VALUE\n        return VALUE\n"),
    })
    assert load(root, "veyra_fixture_pkg/nested/main.py").answer() == 37


def test_parent_importing_entrypoint_uses_one_module(tmp_path):
    root = snapshot(tmp_path, {
        "veyra_fixture_pkg/__init__.py": "from .main import Example\n",
        "veyra_fixture_pkg/main.py": ENTRY,
    })
    strategy = load(root, "veyra_fixture_pkg/main.py")
    assert type(strategy) is sys.modules["veyra_fixture_pkg"].Example
    assert type(strategy) is sys.modules["veyra_fixture_pkg.main"].Example


def test_root_helper_can_import_entrypoint_without_second_execution(tmp_path):
    root = snapshot(tmp_path, {
        "main.py": "class Marker:\n    pass\nfrom veyra_fixture_helper import MARKER\n"
                   + ENTRY.replace("7", "MARKER"),
        "veyra_fixture_helper.py": "from main import Marker\nMARKER = Marker\n",
    })
    strategy = load(root)
    assert strategy.value is sys.modules["main"].Marker
    assert type(strategy).__module__ == "main"


@pytest.mark.parametrize("entrypoint, init", (
    ("main.py", None), ("nested/main.py", None),
    ("outer/nested/main.py", "outer/nested/__init__.py"),
    ("bad-name/main.py", "bad-name/__init__.py"),
))
def test_relative_import_requires_full_named_package_chain(tmp_path, entrypoint, init):
    files = {entrypoint: "from .helper import VALUE\n" + ENTRY, "helper.py": "VALUE = 1\n"}
    if init:
        files[init] = "LABEL = 'incomplete package'\n"
    root = snapshot(tmp_path, files)
    with pytest.raises(ImportError, match="no known parent package"):
        load(root, entrypoint)


@pytest.mark.parametrize("parent", ("", "outer/nested/", "bad-name/"))
def test_initializer_without_named_package_chain_keeps_package_identity(tmp_path, parent):
    root = snapshot(tmp_path, {
        parent + "__init__.py": "from .helper import VALUE\n" + ENTRY.replace("7", "VALUE"),
        parent + "helper.py": "VALUE = 29\n",
    })
    strategy = load(root, parent + "__init__.py")
    assert strategy.value == 29
    assert type(strategy).__module__ == "user_strategy"


def test_hyphenated_entry_module_inside_named_package(tmp_path):
    root = snapshot(tmp_path, {
        "veyra_fixture_pkg/__init__.py": "LABEL = 'package'\n",
        "veyra_fixture_pkg/helper.py": "VALUE = 33\n",
        "veyra_fixture_pkg/my-strategy.py": (
            "from .helper import VALUE\n" + ENTRY.replace("7", "VALUE")),
    })
    strategy = load(root, "veyra_fixture_pkg/my-strategy.py")
    assert strategy.value == 33
    assert type(strategy).__module__ == "veyra_fixture_pkg.my-strategy"


def test_root_initializer_self_import_uses_one_module(tmp_path):
    root = snapshot(tmp_path, {"__init__.py": ENTRY + (
        "import __init__\nExample.same_identity = Example is __init__.Example\n")})
    strategy = load(root, "__init__.py")
    assert strategy.same_identity
    assert sys.modules["user_strategy"] is sys.modules["__init__"]


def test_runtime_modules_win_over_project_names(tmp_path):
    import fractions

    import veyra_sdk

    root = snapshot(tmp_path, {
        "main.py": "import fractions\n" + ENTRY.replace("7", "fractions.Fraction(3, 2)"),
        "fractions.py": "VALUE = 'not stdlib'\n",
        "veyra_sdk/__init__.py": "VALUE = 'not SDK'\n",
    })
    assert load(root).value == fractions.Fraction(3, 2)
    assert sys.modules["veyra_sdk"] is veyra_sdk
    assert sys.modules["fractions"] is fractions


def test_root_entrypoint_named_for_runtime_module_does_not_replace_it(tmp_path):
    import json

    root = snapshot(tmp_path, {"json.py": "import json\n" + ENTRY.replace("7", "json.loads('47')")})
    strategy = load(root, "json.py")
    assert strategy.value == 47
    assert type(strategy).__module__ == "user_strategy"
    assert sys.modules["json"] is json


def test_unloaded_standard_library_module_wins_over_project_file(tmp_path, monkeypatch):
    monkeypatch.delitem(sys.modules, "colorsys", raising=False)
    root = snapshot(tmp_path, {
        "main.py": "import colorsys\n" + ENTRY.replace("7", "colorsys.rgb_to_hsv(1, 0, 0)"),
        "colorsys.py": "VALUE = 'snapshot'\n",
    })
    assert load(root).value == (0, 1, 1)
    assert not sys.modules["colorsys"].__file__.startswith(str(root))


def test_reserved_entry_module_never_overwrites_existing_module(tmp_path, monkeypatch):
    marker = Mock()
    monkeypatch.setitem(sys.modules, "user_strategy", marker)
    root = snapshot(tmp_path, {"nested/main.py": ENTRY})
    with pytest.raises(RuntimeError, match="reserved entrypoint module"):
        load(root, "nested/main.py")
    assert sys.modules["user_strategy"] is marker
    assert str(root) not in sys.path


def test_snapshot_imports_do_not_search_parent_projects(tmp_path):
    (tmp_path / "veyra_private_helper.py").write_text("VALUE = 53\n", encoding="utf-8")
    root = snapshot(tmp_path, {"main.py": "import veyra_private_helper\n" + ENTRY})
    with pytest.raises(ModuleNotFoundError, match="veyra_private_helper"):
        load(root)
    assert str(tmp_path) not in sys.path


@pytest.mark.parametrize("name", ("json", "veyra_sdk", "xml", "sys"))
def test_nested_package_runtime_collision_fails_before_loading(tmp_path, name):
    root = snapshot(tmp_path, {f"{name}/__init__.py": "LABEL = 'project'\n",
                               f"{name}/main.py": ENTRY})
    before = sys.modules.copy()
    with pytest.raises(RuntimeError, match="conflicts with a runtime module"):
        load(root, f"{name}/main.py")
    assert str(root) not in sys.path
    assert sys.modules == before


def test_only_locally_declared_distinct_strategy_classes_count(tmp_path):
    root = snapshot(tmp_path, {
        "veyra_fixture_helper.py": HELPER_BASE,
        "main.py": "from veyra_fixture_helper import Base\nclass Example(Base):\n"
                   "    value = 41\nAlias = Example\n",
    })
    strategy = load(root)
    assert isinstance(strategy, Strategy)
    assert strategy.value == 41


@pytest.mark.parametrize("source, count", (
    ("from veyra_fixture_helper import Base\n", 0),
    (ENTRY + "class Second(Strategy):\n    pass\n", 2),
))
def test_missing_or_ambiguous_entry_class_does_not_instantiate(
        tmp_path, source, count, monkeypatch):
    root = snapshot(tmp_path, {
        "main.py": source,
        "veyra_fixture_helper.py": HELPER_BASE,
    })
    constructor = Mock(side_effect=AssertionError("No class should be instantiated"))
    monkeypatch.setattr(Strategy, "__init__", constructor)
    with pytest.raises(RuntimeError, match=f"defined in the entrypoint, found {count}"):
        load(root)
    constructor.assert_not_called()


def test_entry_module_registered_for_dataclass_annotations(tmp_path):
    root = snapshot(tmp_path, {"main.py": (
        "from __future__ import annotations\nfrom dataclasses import dataclass\n"
        "@dataclass\nclass Value:\n    number: int = 43\n" + ENTRY.replace("7", "Value().number"))})
    assert load(root).value == 43


def test_missing_dependency_stays_an_import_error(tmp_path):
    root = snapshot(tmp_path, {"main.py": "import veyra_nonexistent_third_party_fixture\n" + ENTRY})
    with pytest.raises(ModuleNotFoundError, match="veyra_nonexistent_third_party_fixture"):
        load(root)
    assert "main" not in sys.modules


@pytest.mark.parametrize("entrypoint, module_name", (
    ("main.py", "main"), ("nested/main.py", "user_strategy"),
    ("__init__.py", "user_strategy"), ("veyra_fixture_pkg/main.py", "veyra_fixture_pkg.main"),
))
def test_failed_load_restores_loader_path_and_entry_module(tmp_path, entrypoint, module_name):
    root = snapshot(tmp_path, {entrypoint: "VALUE = 1\n",
                               "veyra_fixture_pkg/__init__.py": "LABEL = 'package'\n"})
    original = sys.path[:]
    with pytest.raises(RuntimeError, match="found 0"):
        load(root, entrypoint)
    assert sys.path == original
    assert module_name not in sys.modules
    if entrypoint == "__init__.py":
        assert "__init__" not in sys.modules


@pytest.mark.parametrize("symlink", (False, True))
def test_entrypoint_cannot_escape_root(tmp_path, symlink):
    root = snapshot(tmp_path, {"main.py": ENTRY})
    outside = tmp_path / "outside.py"
    outside.write_text(ENTRY, encoding="utf-8")
    entry = outside
    if symlink:
        entry = root / "escape.py"
        entry.symlink_to(outside)
    with pytest.raises(RuntimeError, match="inside the snapshot root"):
        _load_strategy(str(entry), root)
    assert str(root) not in sys.path


def test_package_initializer_symlink_cannot_escape_root(tmp_path):
    root = snapshot(tmp_path, {"veyra_fixture_pkg/main.py": ENTRY})
    outside = tmp_path / "outside.py"
    outside.write_text("LABEL = 'outside'\n", encoding="utf-8")
    (root / "veyra_fixture_pkg/__init__.py").symlink_to(outside)
    with pytest.raises(RuntimeError, match="initializer must be inside"):
        load(root, "veyra_fixture_pkg/main.py")
    assert str(root) not in sys.path


@pytest.fixture
def mocked_launch(monkeypatch, tmp_path):
    workdir = tmp_path / "runtime"
    workdir.mkdir()
    monkeypatch.setattr(sandbox.tempfile, "mkdtemp", Mock(return_value=str(workdir)))
    process = Mock(stdin=io.StringIO(), stdout=io.StringIO(), stderr=io.StringIO())
    process.poll.return_value = 0
    popen = Mock(return_value=process)
    monkeypatch.setattr(sandbox.subprocess, "Popen", popen)
    monkeypatch.setattr(sandbox.threading, "Thread", Mock())
    return workdir, popen


def test_process_preserves_exact_snapshot_and_selected_entrypoint(mocked_launch):
    workdir, popen = mocked_launch
    files = {"main.py": "LABEL = 'unselected'\r\n", "pkg/__init__.py": "",
             "pkg/run.py": "# café\r\n" + ENTRY, "helper.py": "VALUE = 3\r"}
    original = files.copy()
    with sandbox.StrategyProcess(files, "pkg/run.py", sandbox.SandboxLimits()):
        args, kwargs = popen.call_args
        assert args[0] == [sys.executable, "-I", "-m", "veyra_sdk.host",
                           str(workdir / "pkg/run.py")]
        assert kwargs["cwd"] == workdir
        assert "PYTHONPATH" not in kwargs["env"]
        assert {str(p.relative_to(workdir)): p.read_bytes() for p in workdir.rglob("*.py")} == {
            name: text.encode("utf-8") for name, text in original.items()}
        assert files == original
    assert not workdir.exists()


@pytest.mark.parametrize("path", ("../outside.py", "/outside.py", "a/../main.py",
                                  "a//main.py", "./main.py", "a\\main.py", "main.txt"))
def test_invalid_snapshot_path_cleans_up_without_launch(mocked_launch, path):
    workdir, popen = mocked_launch
    with pytest.raises(sandbox.StrategyError, match="illegal path"):
        sandbox.StrategyProcess({path: ENTRY}, path, sandbox.SandboxLimits())
    popen.assert_not_called()
    assert not workdir.exists()


@pytest.mark.parametrize("entrypoint", ("missing.py", "sub/../main.py", "../main.py"))
def test_entrypoint_must_be_exact_snapshot_key(mocked_launch, entrypoint):
    workdir, popen = mocked_launch
    with pytest.raises(sandbox.StrategyError, match="one of the snapshot files"):
        sandbox.StrategyProcess({"main.py": ENTRY}, entrypoint, sandbox.SandboxLimits())
    popen.assert_not_called()
    assert not workdir.exists()


def test_failed_launch_cleans_up_snapshot(mocked_launch):
    workdir, popen = mocked_launch
    popen.side_effect = OSError("fixture launch failure")
    with pytest.raises(OSError, match="fixture launch failure"):
        sandbox.StrategyProcess({"main.py": ENTRY}, "main.py", sandbox.SandboxLimits())
    assert not workdir.exists()
