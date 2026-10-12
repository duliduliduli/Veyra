// Synthetic device-only checks. No browser launch, source execution, network, or account is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url);
const { create } = require("../../apps/web/saved-links.js");
const KEY = "veyra.saved-links.v1";
const id = "12345678-1234-4567-890a-123456789abc";
const nextId = "22345678-1234-4567-890a-123456789abc";
const input = { publication_id: id, saved_title: "Synthetic trend", folder: "  Research  " };
class Storage {
  values = new Map(); reads = 0; writes = 0; failRead = false; failWrite = false;
  getItem(key) { this.reads++; if (this.failRead) throw new Error("blocked"); return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failWrite) throw new Error("quota"); this.values.set(key, value); this.writes++; }
}
const reject = (action, status, code) => assert.throws(action, (error) => error.status === status && (!code || error.code === code));

test("save only the public link and private metadata, with one bookmark per canonical publication", () => {
  const storage = new Storage(), store = create(storage);
  assert.equal(storage.reads, 0); assert.equal(storage.writes, 0);
  assert.deepEqual(store.listLinks(), { links: [] });
  const saved = store.saveLink({ ...input, publication_id: id.toUpperCase(), files: { "secret.py": "do not store" }, owner: "private", description: "do not store" });
  assert.deepEqual(Object.keys(saved).sort(), ["publication_id", "saved_title", "folder", "created_at", "updated_at"].sort());
  assert.equal(saved.publication_id, id); assert.equal(saved.saved_title, "Synthetic trend"); assert.equal(saved.folder, "Research");
  assert.equal(saved.created_at, saved.updated_at); assert.equal(new Date(saved.created_at).toISOString(), saved.created_at);
  const writes = storage.writes;
  assert.deepEqual(store.saveLink({ publication_id: id, saved_title: "Changed public title", folder: "Other" }), saved);
  assert.equal(storage.writes, writes, "Repeated save must preserve existing private metadata without writing");
  saved.saved_title = "Changed result";
  assert.equal(create(storage).getLink(id).saved_title, "Synthetic trend");
  assert.deepEqual([...storage.values.keys()], [KEY]);
  assert.doesNotMatch(storage.values.get(KEY), /secret|owner|description|files/);
});

test("move and remove require reviewed metadata; every operation rereads shared storage", () => {
  const storage = new Storage(), store = create(storage), another = create(storage);
  const saved = store.saveLink(input);
  const moved = another.moveLink(id.toUpperCase(), { folder: " Signals ", expected_updated_at: saved.updated_at });
  assert.equal(moved.folder, "Signals"); assert.equal(moved.saved_title, saved.saved_title); assert.equal(moved.created_at, saved.created_at);
  assert.ok(moved.updated_at > saved.updated_at);
  assert.deepEqual(store.getLink(id), moved);
  const before = storage.values.get(KEY), writes = storage.writes;
  for (const action of [() => store.moveLink(id, { folder: "Stale", expected_updated_at: saved.updated_at }), () => store.removeLink(id, { expected_updated_at: saved.updated_at })]) reject(action, 409, "LINK_CONFLICT");
  assert.equal(storage.values.get(KEY), before); assert.equal(storage.writes, writes);
  assert.deepEqual(store.moveLink(id, { folder: "Signals", expected_updated_at: moved.updated_at }), moved);
  assert.equal(storage.writes, writes, "Moving to the same folder is a no-op");
  store.saveLink({ ...input, publication_id: nextId, folder: "" });
  assert.equal(store.listLinks().links.length, 2);
  assert.deepEqual(store.removeLink(id, { expected_updated_at: moved.updated_at }), { publication_id: id, removed: true });
  reject(() => another.getLink(id), 404, "NOT_FOUND");
  assert.equal(store.listLinks().links.length, 1);
});

test("validation rejects malformed identities, metadata and stale-review inputs without mutation or getter invocation", () => {
  const storage = new Storage(), store = create(storage), saved = store.saveLink(input);
  const before = storage.values.get(KEY), writes = storage.writes;
  for (const publication_id of [null, 7, "", ` ${id}`, `${id}\n`, `https://example.test/#public/${id}`, "local-" + id]) reject(() => store.saveLink({ ...input, publication_id }), 422);
  for (const saved_title of [null, 3, "", "  ", "x".repeat(121), "a\nb", "a\u0000b", "a\ud800b", "😀".repeat(121)]) reject(() => store.saveLink({ ...input, saved_title }), 422);
  for (const name of [null, 3, "a/b", "a\\b", "x".repeat(81), "a\u007fb", "\udfff"]) {
    reject(() => store.saveLink({ ...input, folder: name }), 422);
    reject(() => store.moveLink(id, { folder: name, expected_updated_at: saved.updated_at }), 422);
  }
  for (const expected_updated_at of [undefined, null, "yesterday", "2026-10-12", 3]) {
    reject(() => store.moveLink(id, { folder: "New", expected_updated_at }), 422);
    reject(() => store.removeLink(id, { expected_updated_at }), 422);
  }
  reject(() => store.saveLink(null), 422); reject(() => store.moveLink(id, null), 422); reject(() => store.removeLink(id, null), 422);
  let invoked = false;
  const accessor = { ...input };
  Object.defineProperty(accessor, "saved_title", { get() { invoked = true; return "Unexpected"; } });
  reject(() => store.saveLink(accessor), 422); assert.equal(invoked, false);
  assert.equal(storage.values.get(KEY), before); assert.equal(storage.writes, writes);
  assert.equal(create(new Storage()).saveLink({ ...input, saved_title: "x".repeat(120), folder: "f".repeat(80) }).saved_title.length, 120);
  assert.equal(create(new Storage()).saveLink({ ...input, saved_title: "😀".repeat(120) }).saved_title, "😀".repeat(120), "Every valid 120-code-point public title survives without truncation");
  for (const saved_title of ["\ufeff", "\ufeffTitle\ufeff", "A\u0080B"]) assert.equal(create(new Storage()).saveLink({ ...input, saved_title }).saved_title, saved_title);
});

test("blocked reads, quota failures and unavailable storage report errors without overwriting existing bytes", () => {
  const storage = new Storage(), store = create(storage), saved = store.saveLink(input);
  const before = storage.values.get(KEY), writes = storage.writes;
  storage.failWrite = true;
  for (const action of [() => store.saveLink({ ...input, publication_id: nextId }), () => store.moveLink(id, { folder: "New", expected_updated_at: saved.updated_at }), () => store.removeLink(id, { expected_updated_at: saved.updated_at })]) {
    reject(action, 507, "STORAGE_WRITE_FAILED"); assert.equal(storage.values.get(KEY), before); assert.equal(storage.writes, writes);
  }
  storage.failWrite = false; storage.failRead = true;
  reject(() => store.listLinks(), 503, "STORAGE_READ_FAILED"); reject(() => store.saveLink(input), 503, "STORAGE_READ_FAILED");
  assert.equal(storage.values.get(KEY), before); assert.equal(storage.writes, writes);
  reject(() => create(null).listLinks(), 503, "STORAGE_UNAVAILABLE"); reject(() => create({}).listLinks(), 503, "STORAGE_UNAVAILABLE");
});

test("corrupt or unsupported saved data remains untouched by every operation", () => {
  const storage = new Storage(), store = create(storage), saved = store.saveLink(input);
  const original = storage.values.get(KEY), bad = ["", "{bad", "null", "[]", "{}", '{"schema_version":2,"links":[]}'];
  for (const damage of [
    (value) => { value.extra = true; }, (value) => { delete value.last_updated_at; },
    (value) => { value.last_updated_at = null; }, (value) => { value.last_updated_at = "+010000-01-01T00:00:00.000Z"; }, (value) => { value.last_updated_at = "2000-01-01T00:00:00.000Z"; }, (value) => { value.links[0].files = {}; },
    (value) => { value.links[0].description = "Must not persist"; }, (value) => { value.links[0].publication_id = id.toUpperCase(); },
    (value) => { value.links[0].saved_title = " "; }, (value) => { value.links[0].folder = "nested/folder"; },
    (value) => { delete value.links[0].folder; }, (value) => { value.links[0].updated_at = "bad"; },
    (value) => { value.links[0].updated_at = "2000-01-01T00:00:00.000Z"; }, (value) => { value.links.push({ ...value.links[0] }); },
  ]) { const value = JSON.parse(original); damage(value); bad.push(JSON.stringify(value)); }
  for (const raw of bad) {
    storage.values.set(KEY, raw); const writes = storage.writes;
    for (const action of [() => store.listLinks(), () => store.getLink(id), () => store.saveLink(input), () => store.moveLink(id, { folder: "New", expected_updated_at: saved.updated_at }), () => store.removeLink(id, { expected_updated_at: saved.updated_at })]) reject(action, 500, "CORRUPT_STORAGE");
    assert.equal(storage.values.get(KEY), raw); assert.equal(storage.writes, writes);
  }
});

test("bounded link count and browser/CommonJS exports, without storage access at script load", () => {
  const storage = new Storage(), store = create(storage), saved = store.saveLink(input);
  const value = { schema_version: 1, last_updated_at: saved.updated_at, links: Array.from({ length: 1000 }, (_, i) => ({ ...saved, publication_id: `${i.toString(16).padStart(8, "0")}-1234-4567-890a-123456789abc` })) };
  storage.values.set(KEY, JSON.stringify(value)); const before = storage.values.get(KEY), writes = storage.writes;
  reject(() => store.saveLink(input), 409, "LINK_LIMIT"); assert.equal(storage.values.get(KEY), before); assert.equal(storage.writes, writes);
  assert.equal(store.listLinks().links.length, 1000);
  const source = readFileSync(new URL("../../apps/web/saved-links.js", import.meta.url), "utf8");
  let reads = 0;
  const browser = {};
  Object.defineProperty(browser, "localStorage", { get() { reads++; return new Storage(); } });
  runInNewContext(source, browser); assert.equal(reads, 0); assert.equal(typeof browser.VeyraSavedLinks.create, "function");
  assert.equal(browser.VeyraSavedLinks.create().saveLink(input).saved_title, "Synthetic trend"); assert.equal(reads, 1);
  const blocked = {}; Object.defineProperty(blocked, "localStorage", { get() { throw new Error("blocked"); } });
  runInNewContext(source, blocked); reject(() => blocked.VeyraSavedLinks.create().listLinks(), 503, "STORAGE_UNAVAILABLE");
});

for (const backward of [false, true]) test(`old reviews cannot mutate a recreated link with a ${backward ? "backward" : "fixed"} wall clock`, () => {
  let wall = Date.parse("2026-10-12T10:00:00.000Z");
  class Clock extends Date { static now() { return wall; } }
  const context = { Date: Clock };
  runInNewContext(readFileSync(new URL("../../apps/web/saved-links.js", import.meta.url), "utf8"), context);
  const storage = new Storage(), store = context.VeyraSavedLinks.create(storage);
  const first = store.saveLink({ ...input, folder: "First" });
  store.removeLink(id, { expected_updated_at: first.updated_at });
  const afterRemove = JSON.parse(storage.values.get(KEY));
  assert.deepEqual(afterRemove.links, []); assert.ok(afterRemove.last_updated_at > first.updated_at);
  if (backward) wall -= 24 * 60 * 60 * 1000;
  const second = context.VeyraSavedLinks.create(storage).saveLink({ ...input, folder: "Second" });
  assert.ok(second.updated_at > afterRemove.last_updated_at);
  const before = storage.values.get(KEY), writes = storage.writes;
  for (const action of [() => store.removeLink(id, { expected_updated_at: first.updated_at }), () => store.moveLink(id, { folder: "Stale", expected_updated_at: first.updated_at })]) reject(action, 409, "LINK_CONFLICT");
  assert.equal(storage.values.get(KEY), before); assert.equal(storage.writes, writes);
  assert.equal(store.getLink(id).folder, "Second");
});

test("the last supported timestamp stays readable and clock saturation fails before any write", () => {
  const storage = new Storage(), store = create(storage), saved = store.saveLink(input);
  const last = "9999-12-31T23:59:59.999Z", value = JSON.parse(storage.values.get(KEY));
  value.last_updated_at = last; value.links[0].created_at = last; value.links[0].updated_at = last;
  storage.values.set(KEY, JSON.stringify(value));
  assert.equal(store.listLinks().links[0].updated_at, last);
  const before = storage.values.get(KEY), writes = storage.writes;
  for (const action of [
    () => store.moveLink(id, { folder: "New", expected_updated_at: last }),
    () => store.removeLink(id, { expected_updated_at: last }),
    () => store.saveLink({ ...input, publication_id: nextId }),
  ]) {
    reject(action, 409, "STORAGE_CLOCK_LIMIT");
    assert.equal(storage.values.get(KEY), before); assert.equal(storage.writes, writes);
    assert.equal(store.getLink(id).folder, saved.folder); assert.equal(store.listLinks().links.length, 1);
  }
  const context = { Date: class extends Date { static now() { return Date.parse(last) + 1; } } };
  runInNewContext(readFileSync(new URL("../../apps/web/saved-links.js", import.meta.url), "utf8"), context);
  const emptyStorage = new Storage();
  reject(() => context.VeyraSavedLinks.create(emptyStorage).saveLink(input), 409, "STORAGE_CLOCK_LIMIT");
  assert.equal(emptyStorage.writes, 0); assert.equal(emptyStorage.getItem(KEY), null);
});
