# Python snapshot imports (local candidate)

The host now makes the current saved snapshot importable. This changes Python
module resolution inside the existing local/test process only. It does not enable
production execution, install packages, change source storage or authorize a run.

## Import contract

- The process writes the supplied file map into one fresh temporary working
  directory. The selected entrypoint must be an exact key in that map. Paths must
  be canonical relative Python paths; traversal, absolute paths and aliases fail
  before launch. Every source string is written as its exact UTF-8 bytes, including
  CRLF, lone CR, Unicode and empty files. The caller's map and entrypoint are not
  rewritten. Failed materialization or launch removes that temporary directory.
- The host uses its process working directory as the snapshot root. The resolved
  entrypoint and any package initializer it uses must remain within that root.
  It appends only this root to Python's import path, after the runtime paths.
  It never adds the snapshot's parent or a nested script directory to that path.
- Root-absolute imports work: a saved `helpers.py` can be imported with
  `from helpers import VALUE` from `main.py` or `scripts/main.py`. A nested script
  does not get an implicit sibling search path. Use root-absolute imports or
  explicit packages for nested helpers.
- Standard-library, SDK and regular runtime modules take precedence over project
  files. A project `json.py` or
  `veyra_sdk/` does not replace the standard library or SDK. Avoid names already
  used by the runtime for helpers. A selected named package that conflicts with
  an existing runtime module fails clearly and must be renamed; the host never
  silently substitutes the installed package for the selected entrypoint.
  Third-party namespace packages follow Python's usual namespace resolution
  rules, which can merge directories or favor a regular snapshot package. They
  are not a supported per-project dependency contract.
- A nested entrypoint uses its normal dotted module name when every directory
  between root and entrypoint has an `__init__.py` and a valid non-keyword Python
  package name. For example, `research/__init__.py`, `research/main.py` and
  `research/helpers.py`, with entrypoint `research/main.py`, support
  `from .helpers import VALUE`. Deeper complete package chains also support
  parent-relative imports. Python imports their initializers normally. Import
  caching ensures an initializer that imports the entrypoint does not execute
  that entry module again.
- Root scripts use their filename's module name when it does not conflict with
  the runtime. That name is registered before execution, so a helper can import
  the root entrypoint without loading it a second time. A root script named for
  a runtime module, or a nested script without a complete named package chain,
  retains the internal `user_strategy` module name. Such ordinary scripts have
  no relative-import package. Add package markers for path-qualified imports of
  a nested entrypoint; do not also import an unpackaged nested script by another
  module name.
- An explicitly selected `__init__.py` remains supported. With a complete named
  package chain it is that package. At root, or without a complete valid chain,
  it retains the existing `user_strategy` package identity and relative imports
  resolve within that initializer's directory. This is specific to initializer
  entrypoints, not an invented package for ordinary scripts. `user_strategy` is
  reserved for these fallback entrypoints; an existing runtime module with that
  name fails before loading. A root initializer also receives the `__init__`
  alias when that name is unused, avoiding duplicate loading through that spelling.
  Hyphens, digits and keywords in saved entrypoint
  filenames remain executable; they are not rewritten into other filenames.
- Exactly one distinct `Strategy` subclass must be defined in the entry module.
  Imported helper/base classes do not count. Aliases of one locally defined class
  count once. Zero or multiple local subclasses fail without instantiating one.
  Package initializers and helpers still have ordinary Python import side effects.
- Lazy imports during callbacks keep the same snapshot-root context. Missing
  modules raise the normal import error through the existing strategy error
  protocol. There is no dependency installer, requirements-file processing or
  network package resolution. Only the existing runtime and saved Python modules
  are available through this contract.

## Boundaries and verification

The loader is one-shot: one snapshot per process. A failed load restores its import
path and entry-module registrations before the host exits; this is not rollback
of arbitrary imports or source side effects, or a reusable in-process execution
API. Tests restore `sys.path` and
`sys.modules` between cases. Python source may still explicitly read accessible
files, mutate import state or use the network. Path validation and import ordering
are not a filesystem, network or tenant security sandbox. The exact local/test
worker gate is unchanged. See [ADR 0002](adr/0002-local-strategy-isolation.md).

`tests/test_snapshot_imports.py` uses only newly authored trusted constant/class
fixtures in-process and mocked subprocess launches. It checks absolute, relative,
lazy and circular imports; nested and initializer entrypoints; runtime collisions;
class selection; exact source/entrypoint preservation; path and symlink rejection;
missing dependencies; and startup cleanup. No uploaded/user strategy, live service,
database, package install or production isolation test is involved. Actual
subprocess integration requires the candidate SDK to be installed in the tested
environment: `-I` ignores a parent `PYTHONPATH`, so passing compatibility tests
against a different installed SDK does not verify this host change.

## Runtime fingerprint

This source change advances the SDK package to `0.1.1` and the simulator/runtime
fingerprint to `0.1.2`. The engine fingerprint is already included in quote input
hashes and report provenance. New helper-import behavior therefore cannot silently
reuse an approval fingerprint from `0.1.1`: the existing preparation check requires
a fresh quote when runtime inputs differ. Existing immutable versions and reports
are not rewritten. This is a source/package change, not a deployed runtime change.

The integration test environment installs the candidate editable packages from the
existing local dependency cache and verifies the SDK path under `python -I` before
running the six trusted bundled compatibility cases. The shared prior test environment
is unchanged. No dependency was downloaded and no user source was executed.

A final actual-process compatibility test runs only the known bundled SMA and
inert import adapters in three layouts (single file, root-absolute helper and
nested relative package), and checks identical equity, positions, fills and
rejections. This exercises the new host under -I without running user source.
