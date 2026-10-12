# Single-strategy backup contract

`apps/web/strategy-backup.js` is a dependency-free UMD module: CommonJS export in Node, `VeyraStrategyBackup` in the browser. It performs no storage writes, network calls, downloads, Python execution or project updates. UI integration is intentionally separate.

## API

- `exportJSON({ name, description, folder, files, entrypoint, has_unsaved_changes })` returns UTF-8-compatible JSON text with a trailing newline. `files` is the complete current editor snapshot, not the saved version; `entrypoint` and the boolean `has_unsaved_changes` are required. `description` and `folder` default to empty strings; null values export as empty strings. Outer metadata whitespace is trimmed, matching the device workspace. Python text is never trimmed, rewritten or interpreted.
- `importJSON(jsonText | Uint8Array | ArrayBuffer)` validates and returns a deeply frozen preview. For an uploaded file, check `file.size <= LIMITS.jsonBytes` before reading, then pass `await file.arrayBuffer()` so invalid UTF-8 cannot be silently replaced by `File.text()`.
- The preview contains `mode: "create-private-local"`, `project`, `has_unsaved_changes`, `file_count`, `source_bytes`, and `history_included: false`. `project` has only `name`, `description`, `folder`, `files`, `entrypoint`, and forced `visibility: "private"`.
- `FORMAT`, `SCHEMA_VERSION` and frozen `LIMITS` are also exported.

Use the preview to show the name, folder, file list, entrypoint, total source bytes and whether the export included unsaved edits. Treat metadata and Python text as untrusted display text: use `textContent`, never HTML. No preview claims authorship, source integrity, server persistence, verification, or a reproducible run.

After explicit import confirmation, call only the device workspace's `createProject(preview.project)` under its existing Web Lock. Never pass this payload to a save/update endpoint or route it using the current organization's storage mode. The workspace assigns a fresh project ID and first version; pre-existing strategies and drafts remain untouched. For a name collision, let the user choose another name, then pass `{ ...preview.project, name: newName }` to `createProject`. Let the workspace validate that name and handle storage failures without closing the preview or claiming success.

`has_unsaved_changes` is the export-time snapshot flag, not proof of a saved revision. A successfully imported copy starts as a new saved local version 1, even when its exported text contained unsaved edits. The preview retains that source flag for disclosure. No earlier history is reconstructed.

## Version 1 archive

Every field below is required on import; no other fields are accepted:

```json
{
  "format": "veyra-strategy-snapshot",
  "schema_version": 1,
  "name": "Example",
  "description": "",
  "folder": "",
  "files": {
    "strategy.py": "from signals.entry import value\n",
    "signals/entry.py": "value = 1\n",
    "signals/empty.py": ""
  },
  "entrypoint": "strategy.py",
  "has_unsaved_changes": true
}
```

Export explicitly selects those fields. Extra properties on the caller's project object are ignored: no identity IDs, organization, visibility/storage settings, history, run receipts, credentials or share-token metadata are serialized. Import rejects such extra fields rather than trusting them. This is not a secret scanner: the user's exact Python source and metadata may themselves contain sensitive material and are intentionally preserved. The eventual download UI should explain that the file contains the complete source and should be kept private.

## Bounds and rejection rules

- At most 2 MiB of raw JSON UTF-8, including whitespace/escaping. The cap accommodates worst-case JSON escaping of the allowed source. Only strict UTF-8 is accepted for byte input; no UTF-8 BOM. String input and decoded fields also reject unpaired UTF-16 surrogates, matching backend UTF-8 encoding.
- 1–50 Python files; aggregate source at most 256 KiB UTF-8. Blank source is valid. No syntax validation or execution is performed.
- Each path is at most 256 ASCII bytes and follows the existing backend path grammar: slash-separated segments containing letters, digits, `_` and `-`, each starting with a letter, digit or `_`, with a final lowercase `.py`. Absolute paths, traversal, backslashes, trailing newlines and non-Python paths fail. Entrypoint must exactly match a file key.
- Name: 1–120 UTF-16 code units after trimming; description: at most 2,000; folder: at most 80. These use the device workspace's smaller limits (the backend description allows 4,000). No ASCII controls/DEL in metadata except tab/newline/carriage return in descriptions. Folder cannot be a path or `.`/`..`. Import requires already-trimmed metadata; it does not silently change it.
- Unknown schema/format, extra/missing fields, non-boolean unsaved state, duplicate decoded JSON keys, prototype-related object keys, arrays and nesting deeper than root plus files are rejected. A small bounded key/container scan preserves duplicate detection; native `JSON.parse` validates the JSON grammar.
- Errors are `Error` objects with `status: 422` and `code: "INVALID_STRATEGY_BACKUP"`; messages do not echo source or private field values.

This is a strict portable subset, not acceptance parity with every older saved project. The backend counts Unicode code points, while the device workspace counts UTF-16 units; for example, a server-valid 61-emoji name exceeds the local 120-unit limit. Earlier local records may also have control characters in metadata, a `.` folder or paths longer than 256 bytes. Export fails clearly for unsupported records, leaves the existing project untouched and never silently truncates metadata or source. The UI must keep the editor open and show the error. Aligning existing store validators is a separate change.

## Checks

Run `node --check apps/web/strategy-backup.js` and `node --test tests/e2e/strategy-backup.mjs`. Tests exercise exact roundtrips, privacy selection, immutable previews, byte decoding, malformed Unicode, raw and decoded duplicate keys, prototype keys, unknown fields, malformed JSON, unsafe paths, all limits, worst-case escaping and the browser UMD branch.

## Studio integration

Studio has an **Import snapshot** dialog; the editor has **Download snapshot** beside its existing single-file `.py` download. Download uses the complete in-memory file map, including unsaved edits, without saving a version or changing drafts. Unedited CRLF source stays exact: reading `textarea.value` on download would silently normalize it. A visible warning explains that the JSON contains complete private source and should be kept private. Unsupported older metadata or oversized edits fail with a visible error, leaving source open and unchanged.

Import reads `File.arrayBuffer()` only after the 2 MiB file-size check. The strict parser supplies an immutable preview with name, folder, file paths, entrypoint, file count, source byte count and the export-time unsaved flag. Metadata is displayed as text. The preview discloses that prior versions, runs and other drafts are not included. The user may rename the new copy before choosing **Create private device copy**.

Confirmation calls `localWorkspace.createProject` inside the existing exclusive `veyra.workspace.v1` Web Lock, never the organization POST route. This is true with a connected account too. A successful copy opens directly at its new local project route, explicitly labeled device-local, saved v1 and browser-only. Its status also identifies the private device copy. No global storage-mode selector was added: a connected account's existing list still shows database strategies; a local copy can be reopened through its local route or after signing out.

Dialog close/cancel/Escape, newer navigation, newer reads and reopened dialogs invalidate stale work. A queued import rechecks its identity **inside** the lock before writing. Repeated confirmation cannot queue two copies. A write that already committed cannot be undone by later navigation; late completion does not redirect or report success into a newer interaction. Name conflicts focus the editable name, and storage/lock failures keep the preview available for retry. Existing strategies, histories and draft keys are never overwritten.

Run the DOM integration suite with an existing jsdom installation:

```sh
NODE_PATH=/path/to/node_modules node --test tests/e2e/strategy-backup-ui.mjs tests/e2e/studio.mjs tests/e2e/chart-ui.mjs
```

The backup UI suite uses synthetic fixtures only. It covers exact multi-file export, CRLF preservation, connected-account local-only imports, collision rename, failed storage, malformed/oversized bytes, inert metadata/source, multiple imports, two tabs, pending locks, close/cancel/Escape, newer navigation and late completion. Native browser dialog behavior and visual layout remain unverified; browser launch was not attempted. No real user source was downloaded, uploaded or executed.
