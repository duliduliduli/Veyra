import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import backup from "../../apps/web/strategy-backup.js";

const fresh = (changes = {}) => ({ name: "Momentum", description: "Example strategy", folder: "Research",
  files: { "strategy.py": "# unchanged\r\nvalue = '雪 🙂'\n", "signals/empty.py": "", "signals/sma.py": "\tpass\n\n" },
  entrypoint: "strategy.py", has_unsaved_changes: true, ...changes });
const archive = (changes = {}) => ({ ...JSON.parse(backup.exportJSON(fresh())), ...changes });
const rejected = (input, pattern) => assert.throws(() => backup.importJSON(input), (error) =>
  error.code === "INVALID_STRATEGY_BACKUP" && error.status === 422 && (!pattern || pattern.test(error.message)));
const invalid = (changes, pattern) => rejected(JSON.stringify(archive(changes)), pattern);

test("roundtrip preserves every exact source, nested path, blank file and unsaved state", () => {
  for (const unsaved of [true, false]) {
    const original = fresh({ has_unsaved_changes: unsaved });
    const json = backup.exportJSON(original), preview = backup.importJSON(json);
    assert.equal(preview.mode, "create-private-local");
    assert.equal(preview.project.name, original.name);
    assert.equal(preview.project.description, original.description);
    assert.equal(preview.project.folder, original.folder);
    assert.equal(preview.project.entrypoint, original.entrypoint);
    assert.deepEqual(preview.project.files, original.files);
    assert.equal(preview.project.visibility, "private");
    assert.equal(preview.has_unsaved_changes, unsaved);
    assert.equal(preview.history_included, false);
    assert.equal(preview.file_count, 3);
    assert.equal(preview.source_bytes, Object.values(original.files).reduce((total, source) => total + Buffer.byteLength(source), 0));
    assert.equal(backup.exportJSON({ ...preview.project, has_unsaved_changes: preview.has_unsaved_changes }), json);
  }
});

test("export strips identity, history, receipts, credentials and sharing data", () => {
  const original = fresh({ id: "private-id", org_id: "private-org", owner_id: "private-owner", visibility: "public",
    storage: "server", share_token: "private-token", api_key: "private-key", latest_version_no: 19,
    run_receipts: ["private-receipt"], versions: [{ id: "private-version", files: { "old.py": "old text" } }],
    savedFiles: { "old.py": "saved text" } });
  const json = backup.exportJSON(original), result = JSON.parse(json);
  for (const marker of ["private-id", "private-org", "private-owner", "private-token", "private-key", "private-receipt", "private-version", "old text", "saved text"])
    assert.equal(json.includes(marker), false);
  assert.deepEqual(Object.keys(result).sort(), ["format", "schema_version", "name", "description", "folder", "files", "entrypoint", "has_unsaved_changes"].sort());
  assert.equal(own(result, "visibility"), false);
  assert.deepEqual(original.versions, [{ id: "private-version", files: { "old.py": "old text" } }]);
});
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

test("preview is deeply immutable and cannot mutate its source", () => {
  const original = fresh(), json = backup.exportJSON(original), preview = backup.importJSON(json);
  assert.ok(Object.isFrozen(preview));
  assert.ok(Object.isFrozen(preview.project));
  assert.ok(Object.isFrozen(preview.project.files));
  assert.throws(() => { preview.mode = "update"; }, TypeError);
  assert.throws(() => { preview.project.id = "existing-id"; }, TypeError);
  assert.throws(() => { preview.project.files["strategy.py"] = "changed"; }, TypeError);
  original.files["strategy.py"] = "later edit";
  assert.notEqual(preview.project.files["strategy.py"], original.files["strategy.py"]);
  assert.equal(backup.importJSON(json).project.files["signals/empty.py"], "");
});

test("export normalizes metadata and accepts omitted description or empty/null folder", () => {
  const input = fresh({ name: " Name ", description: " line 1\nline 2\t ", folder: null });
  assert.deepEqual(backup.importJSON(backup.exportJSON(input)).project, {
    name: "Name", description: "line 1\nline 2", folder: "", files: input.files, entrypoint: input.entrypoint, visibility: "private",
  });
  delete input.description;
  assert.equal(backup.importJSON(backup.exportJSON(input)).project.description, "");
});

test("import accepts strict UTF-8 bytes, ArrayBuffer and sliced buffers", () => {
  const json = backup.exportJSON(fresh()), encoded = new TextEncoder().encode(json);
  assert.deepEqual(backup.importJSON(encoded), backup.importJSON(json));
  assert.deepEqual(backup.importJSON(encoded.buffer), backup.importJSON(json));
  const surrounded = Buffer.concat([Buffer.from("bad"), Buffer.from(json), Buffer.from("bad")]);
  assert.deepEqual(backup.importJSON(surrounded.subarray(3, surrounded.length - 3)), backup.importJSON(json));
  for (const bad of [[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f]]) rejected(Uint8Array.from(bad), /UTF-8/);
  rejected(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]), /JSON/);
});

test("rejects missing, unknown and authority-bearing archive fields", () => {
  for (const field of Object.keys(archive())) {
    const input = archive(); delete input[field]; rejected(JSON.stringify(input), /fields/);
  }
  for (const field of ["id", "project_id", "org_id", "owner_id", "visibility", "storage", "versions", "history", "run_receipts", "share_token", "api_key", "mode", "__other"])
    invalid({ [field]: "anything" }, /fields/);
  for (const format of ["unknown", "", null, 1]) invalid({ format });
  for (const schema_version of [0, 2, "1", 1.5, null, true]) invalid({ schema_version });
});

test("rejects unsafe and duplicate keys, including escaped spellings", () => {
  const json = backup.exportJSON(fresh());
  for (const key of ["__proto__", "constructor", "prototype", "\\u005f_proto__", "constr\\u0075ctor"])
    rejected(json.replace("{", `{"${key}": {},`), /Unsafe/);
  rejected(json.replace('"name":', '"name":"first", "name":'), /Duplicate/);
  rejected(json.replace('"name":', '"na\\u006de":"first", "name":'), /Duplicate/);
  rejected(json.replace('"strategy.py":', '"strategy.py":"first", "strategy.py":'), /Duplicate/);
  rejected(json.replace('"strategy.py":', '"strat\\u0065gy.py":"first", "strategy.py":'), /Duplicate/);
  assert.equal({}.polluted, undefined);
});

test("JSON scanner leaves braces, key-looking text, escapes and brackets inside source alone", () => {
  const source = String.raw`# {"__proto__":{}, "name":"x", "name":"y"} [ ] \\ \"` + '\n"quote"\t\0';
  assert.equal(backup.importJSON(backup.exportJSON(fresh({ files: { "strategy.py": source } }))).project.files["strategy.py"], source);
});

test("rejects malformed JSON, arrays, trailing data and excessive nesting", () => {
  for (const input of ["", "{", "null", "false", "0", '"text"', "[]", "{}", "NaN", "Infinity", "/* comment */{}",
    '{"name": "unterminated}', '{"name": "\\q"}', '{"name": 1,}', '{"files":{"a.py":{}}}',
    backup.exportJSON(fresh()) + "{}", '['.repeat(10000) + ']'.repeat(10000), '{"x":'.repeat(10000) + "0" + '}'.repeat(10000)]) rejected(input);
  for (const input of [null, undefined, {}, [], 0, new DataView(new ArrayBuffer(1))]) rejected(input);
});

test("rejects path traversal, absolute paths, non-Python files and wrong entrypoint", () => {
  for (const path of ["../strategy.py", "/strategy.py", "C:/strategy.py", "a/../b.py", "a\\b.py", "a//b.py", ".hidden.py",
    "file.PY", "a.py\n", "a.py\r", "a.py\u0000", "a.py ", "a.py/b.py", "雪.py", "a/.py", "-a.py", "http://a.py", "a%2fb.py"])
    invalid({ files: { [path]: "" }, entrypoint: path }, /path/);
  for (const entrypoint of ["missing.py", "__proto__", "constructor", "prototype", "", null, 3, "strategy.py\n"])
    invalid({ entrypoint }, /Entrypoint/);
});

test("enforces path and file-count boundaries", () => {
  const maxPath = "a".repeat(backup.LIMITS.pathBytes - 3) + ".py";
  assert.equal(backup.importJSON(backup.exportJSON(fresh({ files: { [maxPath]: "" }, entrypoint: maxPath }))).file_count, 1);
  invalid({ files: { ["a" + maxPath]: "" }, entrypoint: "a" + maxPath }, /path/);
  const files = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}.py`, ""]));
  assert.equal(backup.importJSON(backup.exportJSON(fresh({ files, entrypoint: "f0.py" }))).file_count, 50);
  invalid({ files: { ...files, "extra.py": "" }, entrypoint: "f0.py" });
  for (const files of [{}, [], null, "text", { "strategy.py": 1 }, { "strategy.py": null }]) invalid({ files });
});

test("source limit counts aggregate UTF-8 bytes without trimming or normalizing text", () => {
  const exact = "雪".repeat(Math.floor(backup.LIMITS.sourceBytes / 3)) + "x";
  assert.equal(Buffer.byteLength(exact), backup.LIMITS.sourceBytes);
  assert.equal(backup.importJSON(backup.exportJSON(fresh({ files: { "strategy.py": exact } }))).source_bytes, backup.LIMITS.sourceBytes);
  invalid({ files: { "strategy.py": exact + "x" } }, /limit|256 KiB/);
  invalid({ files: { "strategy.py": exact, "other.py": "x" } }, /256 KiB/);
  const controls = "\u0000".repeat(backup.LIMITS.sourceBytes);
  const worstEscaped = backup.exportJSON(fresh({ files: { "strategy.py": controls } }));
  assert.ok(Buffer.byteLength(worstEscaped) < backup.LIMITS.jsonBytes);
  assert.equal(backup.importJSON(worstEscaped).project.files["strategy.py"], controls);
});

test("bounds raw JSON bytes before parsing even for whitespace and multibyte input", () => {
  const json = backup.exportJSON(fresh());
  const exact = json + " ".repeat(backup.LIMITS.jsonBytes - Buffer.byteLength(json));
  assert.equal(backup.importJSON(exact).file_count, 3);
  rejected(exact + " ", /size limit/);
  rejected(new Uint8Array(backup.LIMITS.jsonBytes + 1), /size limit/);
  rejected("雪".repeat(Math.floor(backup.LIMITS.jsonBytes / 3) + 1), /size limit/);
});

test("rejects malformed Unicode, invalid metadata and false snapshot-state coercions", () => {
  for (const bad of ["\ud800", "\udfff", "x\ud800x", "\ud800\ud800", "\udc00\ud800", "🙂\udc00"]) {
    invalid({ files: { "strategy.py": bad } }, /UTF-8/);
    invalid({ name: bad }, /UTF-8/);
    rejected(backup.exportJSON(fresh()).replace('"Momentum"', `"${bad}"`), /UTF-8/);
    assert.throws(() => backup.exportJSON(fresh({ files: { "strategy.py": bad } })), /UTF-8/);
  }
  for (const name of ["", "  ", " Name", "Name ", "a".repeat(121), "line\nbreak", "\u007f", null, 4]) invalid({ name });
  for (const description of ["a".repeat(2001), "text\u0000", " text", null, false]) invalid({ description });
  for (const folder of ["a".repeat(81), ".", "..", "a/b", "a\\b", "a\nb", " folder", null, 4]) invalid({ folder });
  for (const has_unsaved_changes of [0, 1, "false", null]) invalid({ has_unsaved_changes });
  const max = fresh({ name: "n".repeat(120), description: "d".repeat(2000), folder: "f".repeat(80) });
  assert.equal(backup.importJSON(backup.exportJSON(max)).project.name.length, 120);
});

test("export requires plain data and explicit entrypoint and unsaved status", () => {
  for (const field of ["entrypoint", "has_unsaved_changes", "name", "files"]) {
    const input = fresh(); delete input[field]; assert.throws(() => backup.exportJSON(input));
  }
  let invoked = false;
  const input = fresh();
  Object.defineProperty(input, "files", { get() { invoked = true; return {}; } });
  assert.throws(() => backup.exportJSON(input), /plain data/);
  assert.equal(invoked, false);
  const files = {}; Object.defineProperty(files, "strategy.py", { enumerable: true, get() { invoked = true; return ""; } });
  assert.throws(() => backup.exportJSON(fresh({ files })), /plain data/);
  assert.equal(invoked, false);
  assert.throws(() => backup.exportJSON(Object.create(fresh())), /object/);
  const nullFiles = Object.assign(Object.create(null), { "strategy.py": "" });
  assert.equal(backup.importJSON(backup.exportJSON(fresh({ files: nullFiles }))).source_bytes, 0);
});

test("UMD browser export has no DOM, storage, network or execution dependencies", () => {
  const sandbox = vm.createContext({ TextEncoder, TextDecoder, ArrayBuffer, Uint8Array });
  vm.runInContext(readFileSync(new URL("../../apps/web/strategy-backup.js", import.meta.url), "utf8"), sandbox);
  assert.equal(sandbox.VeyraStrategyBackup.FORMAT, backup.FORMAT);
  const json = backup.exportJSON(fresh());
  sandbox.json = json;
  const result = vm.runInContext("VeyraStrategyBackup.importJSON(json)", sandbox);
  assert.equal(result.project.files["signals/empty.py"], "");
  assert.equal(vm.runInContext("Object.isFrozen(VeyraStrategyBackup.importJSON(json).project.files)", sandbox), true);
});

test("deterministic mixed Unicode and JSON punctuation sources roundtrip exactly", () => {
  let seed = 1729;
  const chars = ['"', "\\", "{", "}", "[", "]", ":", ",", " ", "\n", "\r", "\t", "\0", "a", "雪", "🙂", "\u2028", "\u2029", "\u007f"];
  for (let sample = 0; sample < 100; sample++) {
    let source = "";
    for (let character = 0; character < 150; character++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      source += chars[seed % chars.length];
    }
    assert.equal(backup.importJSON(backup.exportJSON(fresh({ files: { "strategy.py": source } }))).project.files["strategy.py"], source);
  }
});

test("unsupported older/server records fail clearly without truncation or mutation", () => {
  const examples = [
    [fresh({ description: "d".repeat(2001) }), /Description exceeds 2000/],
    [fresh({ name: "🙂".repeat(61) }), /Name exceeds 120/],
    [fresh({ name: "tab\tname" }), /control characters/],
    [fresh({ folder: "." }), /flat name/],
    [fresh({ files: { ["a".repeat(254) + ".py"]: "keep this exact source\r\n" }, entrypoint: "a".repeat(254) + ".py" }), /at most 256 ASCII bytes/],
  ];
  for (const [input, reason] of examples) {
    const before = JSON.stringify(input);
    assert.throws(() => backup.exportJSON(input), reason);
    assert.equal(JSON.stringify(input), before);
  }
  assert.equal(backup.importJSON(backup.exportJSON(fresh({ name: "🙂".repeat(60) }))).project.name, "🙂".repeat(60));
});
