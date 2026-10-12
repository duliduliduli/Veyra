// Device-local persistence checks: node tests/e2e/workspace-store.mjs
// No browser, network, API, account, database, or uploaded code is used.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { create } = require("../../apps/web/workspace-store.js");
const KEY = "veyra.workspace.v1";
const ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const files = { "strategy.py": "from helpers.signals import signal\n", "helpers/signals.py": "signal = '☀'\n" };
const initial = { name: "  Trend research  ", description: "  A private experiment  ", folder: "  Momentum  ", files };

class Storage {
  values = new Map();
  reads = 0;
  writes = 0;
  failRead = false;
  failWrite = false;
  getItem(key) {
    this.reads += 1;
    if (this.failRead) throw new Error("SecurityError");
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    if (this.failWrite) throw new Error("QuotaExceededError");
    this.values.set(key, value);
    this.writes += 1;
  }
}

function rejected(action, status, code) {
  assert.throws(action, (error) => error.status === status && (!code || error.code === code));
}

const storage = new Storage(), store = create(storage);
assert.equal(storage.reads, 0, "Constructing the API must not read or write storage");
assert.equal(storage.writes, 0);
assert.deepEqual(store.listProjects(), { projects: [] });
const project = store.createProject(initial);
assert.match(project.id, ID);
assert.match(project.latest_version_id, ID);
assert.notEqual(project.id, project.latest_version_id);
assert.equal(project.name, "Trend research");
assert.equal(project.description, "A private experiment");
assert.equal(project.folder, "Momentum");
assert.equal(project.visibility, "private");
assert.equal(project.latest_version_no, 1);
assert.equal(project.latest_version.version_no, 1);
assert.equal(project.latest_version.project_id, project.id);
assert.equal(project.latest_version.content_hash, null, "Local content must never claim server verification");
assert.equal(project.latest_version.entrypoint, "strategy.py");
assert.equal(project.latest_version.created_at, project.created_at);
assert.ok(Number.isFinite(Date.parse(project.updated_at)));
assert.deepEqual(project.latest_version.files, files);
assert.deepEqual(store.getVersion(project.id, 1), project.latest_version);
assert.deepEqual(store.getProject(project.id).versions, [project.latest_version]);
assert.equal(store.listProjects().projects[0].latest_version, undefined);
assert.equal(store.listProjects().projects[0].versions, undefined);
assert.deepEqual(JSON.parse(JSON.stringify(project)), project, "The public result must be JSON serializable");
assert.deepEqual([...storage.values.keys()], [KEY]);

// Each operation rereads shared storage, and neither arguments nor results are live references.
const anotherTab = create(storage);
assert.deepEqual(anotherTab.getProject(project.id), store.getProject(project.id));
const originalText = files["strategy.py"];
files["strategy.py"] = "mutated input";
project.latest_version.files["strategy.py"] = "mutated result";
assert.equal(anotherTab.getVersion(project.id, 1).files["strategy.py"], originalText);
files["strategy.py"] = originalText;
const saved = store.saveVersion(project.id, {
  files: { ...files, "strategy.py": "# revised entry\n", "alternate.py": "# alternate entry\n" },
  entrypoint: "alternate.py", expected_version_no: 1,
});
assert.equal(saved.version_no, 2);
assert.equal(saved.content_hash, null);
assert.deepEqual(anotherTab.getProject(project.id).versions.map((version) => version.version_no), [2, 1]);
assert.equal(anotherTab.getVersion(project.id, 1).files["strategy.py"], originalText);
assert.equal(anotherTab.getVersion(project.id, 2).files["helpers/signals.py"], files["helpers/signals.py"]);
rejected(() => anotherTab.saveVersion(project.id, { files, expected_version_no: 1 }), 409, "VERSION_CONFLICT");
rejected(() => store.saveVersion(project.id, { files }), 422);
rejected(() => store.saveVersion(project.id, { files, expected_version_no: "2" }), 422);
rejected(() => store.saveVersion(project.id, { files, expected_version_no: 3 }), 409, "VERSION_CONFLICT");
assert.equal(store.getProject(project.id).versions.length, 2);

const updated = anotherTab.updateProject(project.id, { name: " Revised trend ", description: "Updated notes", folder: "  Signals  " });
assert.equal(updated.name, "Revised trend");
assert.equal(updated.folder, "Signals");
assert.equal(updated.latest_version_no, 2);
assert.equal(updated.created_at, project.created_at);
assert.equal(updated.visibility, "private");
assert.equal(updated.versions, undefined);
assert.deepEqual(store.getVersion(project.id, 2), saved);
assert.equal(store.listProjects().projects.filter((item) => item.folder === "Signals").length, 1);
assert.equal(store.listProjects().projects.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes("notes")).length, 1);
assert.equal(store.listProjects().projects.filter((item) => item.folder === "Missing").length, 0);

// Duplicate only the latest complete snapshot; retain all source versions.
const copy = store.duplicateProject(project.id);
assert.equal(copy.name, "Revised trend copy");
assert.notEqual(copy.id, project.id);
assert.equal(copy.folder, "Signals");
assert.equal(copy.description, "Updated notes");
assert.equal(copy.latest_version_no, 1);
assert.equal(copy.latest_version.entrypoint, "alternate.py");
assert.deepEqual(copy.latest_version.files, saved.files);
assert.notEqual(copy.latest_version.id, saved.id);
assert.equal(copy.latest_version.project_id, copy.id);
assert.equal(store.getProject(project.id).versions.length, 2);
const copy2 = anotherTab.duplicateProject(project.id);
assert.equal(copy2.name, "Revised trend copy 2");
const namedCopy = store.duplicateProject(project.id, { name: "  My experiment  " });
assert.equal(namedCopy.name, "My experiment");
assert.equal(namedCopy.visibility, "private");
rejected(() => store.duplicateProject(project.id, { name: "My experiment" }), 409, "NAME_CONFLICT");
rejected(() => store.createProject({ ...initial, name: "Revised trend" }), 409, "NAME_CONFLICT");
rejected(() => store.updateProject(project.id, { name: "My experiment" }), 409, "NAME_CONFLICT");
assert.equal(store.updateProject(project.id, { name: " Revised trend " }).name, "Revised trend");

const long = store.createProject({ ...initial, name: "x".repeat(120), visibility: "public" });
assert.equal(long.visibility, "private");
for (let i = 1; i <= 12; i++) {
  const duplicate = store.duplicateProject(long.id);
  assert.ok(duplicate.name.length <= 120);
  assert.ok(duplicate.name.endsWith(i === 1 ? " copy" : ` copy ${i}`));
}
assert.equal(new Set(store.listProjects().projects.map((item) => item.name)).size, store.listProjects().projects.length);
assert.equal(new Set(store.listProjects().projects.map((item) => item.id)).size, store.listProjects().projects.length);

// No history truncation at backend listing limits; every previous revision remains readable.
for (let number = 3; number <= 55; number++) {
  anotherTab.saveVersion(project.id, { files: { ...files, "strategy.py": `# revision ${number}` }, expected_version_no: number - 1 });
}
assert.equal(store.getProject(project.id).versions.length, 55);
assert.equal(store.getProject(project.id).versions[0].version_no, 55);
assert.equal(store.getVersion(project.id, 1).files["strategy.py"], originalText);
assert.deepEqual(store.getVersion(project.id, 2), saved);

const stable = storage.values.get(KEY), writesBeforeValidation = storage.writes;
for (const name of ["", "  ", "x".repeat(121), null, 3]) rejected(() => store.createProject({ ...initial, name }), 422);
for (const folder of ["nested/folder", "nested\\folder", "x".repeat(81), 3]) rejected(() => store.createProject({ ...initial, name: "Invalid folder", folder }), 422);
rejected(() => store.createProject({ ...initial, name: "Long description", description: "x".repeat(2001) }), 422);
rejected(() => store.createProject({ ...initial, name: "Bad description", description: [] }), 422);
for (const path of ["../escape.py", "/root.py", "a/../b.py", "a//b.py", ".hidden.py", "evil.js", "evil.PY", "a\\b.py", "a b.py", "a.py/other.py", "strategy.py\n"]) {
  rejected(() => store.createProject({ name: "Invalid path", files: { [path]: "" }, entrypoint: path }), 422);
}
for (const badFiles of [{}, [], null, "source", { "strategy.py": 1 }, { "strategy.py": null }]) {
  rejected(() => store.createProject({ name: "Invalid source", files: badFiles }), 422);
}
rejected(() => store.createProject({ name: "Missing entrypoint", files: { "other.py": "" } }), 422);
rejected(() => store.createProject({ name: "Inherited entrypoint", files, entrypoint: "toString" }), 422);
rejected(() => store.createProject({ name: "Invalid entrypoint", files, entrypoint: 0 }), 422);
rejected(() => store.createProject({ name: "Large source", files: { "strategy.py": "x".repeat(256 * 1024 + 1) } }), 422);
rejected(() => store.createProject({ name: "UTF-8 source", files: { "strategy.py": "😀".repeat(65537) } }), 422);
rejected(() => store.createProject({ name: "Large total", files: { "strategy.py": "x".repeat(128 * 1024), "helper.py": "x".repeat(128 * 1024 + 1) } }), 422);
rejected(() => store.createProject({ name: "Too many files", files: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`file${i}.py`, ""])), entrypoint: "file0.py" }), 422);
rejected(() => store.updateProject(project.id, { folder: "a/b" }), 422);
rejected(() => store.updateProject(project.id, null), 422);
rejected(() => store.duplicateProject(project.id, null), 422);
rejected(() => store.saveVersion(project.id, { files: {}, expected_version_no: 55 }), 422);
rejected(() => store.getProject("missing"), 404);
rejected(() => store.getVersion(project.id, 56), 404);
rejected(() => store.saveVersion("missing", { files, expected_version_no: 1 }), 404);
rejected(() => store.updateProject("missing", { name: "Absent" }), 404);
rejected(() => store.duplicateProject("missing"), 404);
assert.equal(storage.values.get(KEY), stable, "Rejected input must never write storage");
assert.equal(storage.writes, writesBeforeValidation);

const boundaries = create(new Storage());
boundaries.createProject({ name: "Limits", description: "d".repeat(2000), folder: "f".repeat(80), files: { "strategy.py": "😀".repeat(65536) } });
boundaries.createProject({ name: "50 files", files: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`file${i}.py`, ""])), entrypoint: "file0.py" });
assert.equal(boundaries.listProjects().projects.length, 2);

// Failed writes cannot report success or replace any existing data.
storage.failWrite = true;
for (const action of [
  () => store.createProject({ ...initial, name: "Quota failure" }),
  () => store.saveVersion(project.id, { files, expected_version_no: 55 }),
  () => store.updateProject(project.id, { name: "Must not stick" }),
  () => store.duplicateProject(project.id),
]) {
  rejected(action, 507, "STORAGE_WRITE_FAILED");
  assert.equal(storage.values.get(KEY), stable);
}
storage.failWrite = false;
assert.equal(anotherTab.getProject(project.id).latest_version_no, 55);
storage.failRead = true;
rejected(() => store.listProjects(), 503, "STORAGE_READ_FAILED");
rejected(() => store.createProject(initial), 503, "STORAGE_READ_FAILED");
assert.equal(storage.values.get(KEY), stable);
storage.failRead = false;
rejected(() => create(null).listProjects(), 503, "STORAGE_UNAVAILABLE");
rejected(() => create({ getItem() {} }).listProjects(), 503, "STORAGE_UNAVAILABLE");

// Invalid JSON and semantically damaged revisions must be reported, never silently reset.
const corrupt = new Storage(), corruptStore = create(corrupt);
const malformed = ["", "{broken", "null", "[]", "{}", '{"schema_version":2,"projects":[]}'];
for (const damage of [
  (data) => { data.projects[0].visibility = "public"; },
  (data) => { data.projects[0].latest_version_no += 1; },
  (data) => { data.projects[0].versions[0].content_hash = "pretend verified"; },
  (data) => { data.projects[0].versions[0].files = {}; },
  (data) => { data.projects[0].versions[0].project_id = "wrong owner"; },
  (data) => { data.projects[0].versions[0].version_no = 99; },
  (data) => { data.projects[0].versions = []; },
  (data) => { data.projects[0].created_at = "bad timestamp"; },
  (data) => { data.projects[0].id = "not a local ID"; },
  (data) => { data.projects[0].name = data.projects[1].name; },
]) {
  const data = JSON.parse(stable);
  damage(data);
  malformed.push(JSON.stringify(data));
}
for (const raw of malformed) {
  corrupt.values.set(KEY, raw);
  for (const action of [
    () => corruptStore.listProjects(),
    () => corruptStore.getProject(project.id),
    () => corruptStore.getVersion(project.id, 1),
    () => corruptStore.createProject(initial),
    () => corruptStore.saveVersion(project.id, { files, expected_version_no: 55 }),
    () => corruptStore.updateProject(project.id, { name: "No overwrite" }),
    () => corruptStore.duplicateProject(project.id),
  ]) rejected(action, 500, "CORRUPT_STORAGE");
  assert.equal(corrupt.values.get(KEY), raw);
  assert.equal(corrupt.writes, 0);
}

// Browser global and secure UUID fallback, without touching localStorage during script loading.
const source = await readFile(new URL("../../apps/web/workspace-store.js", import.meta.url), "utf8");
let accesses = 0;
const browserStorage = new Storage();
const browser = { TextEncoder, crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } };
Object.defineProperty(browser, "localStorage", { get() { accesses += 1; return browserStorage; } });
runInNewContext(source, browser);
assert.equal(accesses, 0);
assert.equal(typeof browser.VeyraWorkspaceStore.create, "function");
const browserStore = browser.VeyraWorkspaceStore.create();
assert.equal(accesses, 1);
assert.match(browserStore.createProject({ name: "Browser global", files }).id, ID);
const noCrypto = { TextEncoder };
runInNewContext(source, noCrypto);
const secureOnly = new Storage();
rejected(() => noCrypto.VeyraWorkspaceStore.create(secureOnly).createProject(initial), 503, "SECURE_RANDOM_UNAVAILABLE");
assert.equal(secureOnly.writes, 0);

console.log("Workspace store checks passed: private local persistence, full file/revision history, metadata/filtering, duplicates, validation, stale versions, storage failures, corruption, and browser/CommonJS exports.");

// The editor shares pure validation with saves, without writing any storage or touching source bytes.
const { validateSnapshot, validateFilePath } = require("../../apps/web/workspace-store.js");
const exactSource = "\t# mixed endings\r\nvalue = '雪'\rnext = 2\n\n";
const validated = validateSnapshot({ files: { "pkg/main.py": exactSource, "blank.py": "" }, entrypoint: "pkg/main.py" });
assert.deepEqual(validated, { files: { "pkg/main.py": exactSource, "blank.py": "" }, entrypoint: "pkg/main.py" });
for (const path of ["a.py\n", "a.py\r", "a.py\0", "../a.py", "a\\b.py", "a//b.py", "x".repeat(254) + ".py", "constructor", "__proto__"])
  rejected(() => validateFilePath(path), 422);
assert.equal(validateFilePath("x".repeat(253) + ".py").length, 256);
assert.equal(validateFilePath("signals/day_1/entry-point.py"), "signals/day_1/entry-point.py");
for (const text of ["\ud800", "\udfff", "x\ud800x", "\ud800\ud800", "🙂\udc00"])
  rejected(() => validateSnapshot({ files: { "strategy.py": text } }), 422);
let accessorRead = false;
const getterFiles = {}; Object.defineProperty(getterFiles, "strategy.py", { enumerable: true, get() { accessorRead = true; return ""; } });
rejected(() => validateSnapshot({ files: getterFiles }), 422);
const getterSnapshot = {}; Object.defineProperty(getterSnapshot, "files", { get() { accessorRead = true; return { "strategy.py": "" }; } });
rejected(() => validateSnapshot(getterSnapshot), 422);
assert.equal(accessorRead, false, "Validation must not invoke untrusted getters");
rejected(() => validateSnapshot({ files: { "strategy.py\n": "" }, entrypoint: "strategy.py\n" }), 422);
rejected(() => validateSnapshot({ files: { "strategy.py": "" }, entrypoint: null }), 422);
assert.equal(validateSnapshot({ files: { ["x".repeat(254) + ".py"]: exactSource }, entrypoint: "x".repeat(254) + ".py" }).files["x".repeat(254) + ".py"], exactSource,
  "Existing long paths remain inspectable without truncation");

// Optional duplicate version guard preserves old callers while UI copies the displayed immutable source.
const guardedStorage = new Storage(), guardedStore = create(guardedStorage);
const guarded = guardedStore.createProject({ name: "Guarded copy", files: { "strategy.py": exactSource } });
guardedStore.saveVersion(guarded.id, { files: { "renamed.py": exactSource }, entrypoint: "renamed.py", expected_version_no: 1 });
const beforeConflict = guardedStorage.values.get(KEY), guardWrites = guardedStorage.writes;
rejected(() => guardedStore.duplicateProject(guarded.id, { expected_version_no: 1 }), 409, "VERSION_CONFLICT");
for (const expected_version_no of [null, 0, -1, 1.5, "2", true, 2147483648])
  rejected(() => guardedStore.duplicateProject(guarded.id, { expected_version_no }), 422);
assert.equal(guardedStorage.values.get(KEY), beforeConflict); assert.equal(guardedStorage.writes, guardWrites);
const guardedCopy = guardedStore.duplicateProject(guarded.id, { expected_version_no: 2 });
assert.equal(guardedCopy.latest_version.entrypoint, "renamed.py");
assert.deepEqual(guardedCopy.latest_version.files, { "renamed.py": exactSource });
assert.equal(guardedStore.duplicateProject(guarded.id).latest_version.entrypoint, "renamed.py", "Legacy unguarded programmatic callers remain supported");
