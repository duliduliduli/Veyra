// Pure bounded line-review checks. No DOM, source execution, service or network access.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
const { compare, splitLines, lineDetails, visibleWhitespace } = createRequire(import.meta.url)("../../apps/web/proposal-diff.js");

function rebuild(before, result) {
  assert.equal(result.mode, "diff");
  const removed = new Set(result.rows.filter((row) => row.kind === "remove").map((row) => row.oldLine));
  const added = new Map(result.rows.filter((row) => row.kind === "add").map((row) => [row.newLine, row.raw]));
  const remaining = splitLines(before).filter((_, i) => !removed.has(i + 1));
  const output = [];
  let cursor = 0;
  for (let i = 1; i <= result.after.lines; i++) output.push(added.has(i) ? added.get(i) : remaining[cursor++]);
  assert.equal(cursor, remaining.length, "Every retained original line is accounted for");
  return output.join("");
}

test("line tokens preserve CRLF, lone CR, final-newline state, blank lines and Unicode exactly", () => {
  for (const source of ["", "\n", "\r", "\r\n", "\r\n\r\n", "α😀é\r\nb\rc\nend", "a\n\n", "no newline", "\ufeffx\u2028y"]) {
    const lines = splitLines(source);
    assert.equal(lines.join(""), source);
    for (const raw of lines) {
      const details = lineDetails(raw);
      assert.equal(details.text + ({ CRLF: "\r\n", CR: "\r", LF: "\n", none: "" })[details.ending], raw);
    }
  }
  assert.equal(splitLines("").length, 0);
  assert.equal(splitLines("x\n").length, 1, "A final newline adds no phantom empty line");
  assert.equal(compare("", "").before.finalNewline, null);
  assert.equal(compare("x\n", "x").before.finalNewline, true);
  assert.equal(compare("x\n", "x").after.finalNewline, false);
});

test("single parameter replacement has complete changes, 3 context lines and honest omission counts", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join("");
  const after = before.replace("line 15", "updated 15"), diff = compare(before, after);
  assert.equal(diff.added, 1); assert.equal(diff.removed, 1); assert.equal(diff.countsExact, true);
  assert.equal(diff.rows.filter((row) => row.kind === "equal").length, 6);
  assert.deepEqual(diff.rows.filter((row) => row.kind === "gap").map((row) => row.count), [12, 11]);
  assert.equal(diff.rows.find((row) => row.kind === "remove").oldLine, 16);
  assert.equal(diff.rows.find((row) => row.kind === "add").newLine, 16);
  assert.equal(rebuild(before, diff), after);
});

test("insertions, deletions, empty files, repeated lines and complete replacements reconstruct exactly", () => {
  for (const [before, after] of [["", "a\n"], ["a\n", ""], ["a\nb\nc\n", "x\na\nb\nc\ny"],
    ["a\na\na\n", "a\nb\na\n"], ["a\nb\na\n", "b\na\nb\n"], ["a\nb", "c\nd"],
    ["1\n2\n3\n4\n5\n", "x\n2\n3\n4\ny\n"], ["same\n", "same\n"]]) {
    const diff = compare(before, after);
    assert.equal(rebuild(before, diff), after);
    assert.equal(diff.rows.filter((row) => row.kind === "add").length, diff.added);
    assert.equal(diff.rows.filter((row) => row.kind === "remove").length, diff.removed);
  }
});

test("whitespace-only and line-ending-only edits are never hidden or normalized", () => {
  for (const [before, after] of [["\treturn 1 \r\n", "    return 1\r\n"], ["a\r\nb\r", "a\nb\n"],
    ["a\n", "a"], ["a", "a\n"], ["a\u00a0b", "a b"], ["\n", ""], ["a\rb\n", "a\nb\r"]]) {
    const diff = compare(before, after);
    assert.equal(diff.whitespaceOnly, true);
    assert.ok(diff.added + diff.removed > 0);
    assert.equal(rebuild(before, diff), after);
  }
  assert.equal(compare("é", "é").whitespaceOnly, false, "Unicode normalization is forbidden");
  assert.equal(visibleWhitespace("\t x\u00a0😀"), "⇥·x⟦U+00A0⟧😀");
  const diff = compare("a\r", "a");
  assert.deepEqual(diff.rows.map((row) => row.ending), ["CR", "none"]);
});

test("source-looking HTML remains ordinary strings and originals survive visualization", () => {
  const before = '<script>never_execute()</script>\r\n', after = '<img src=x onerror=never_execute()>😀\r';
  const diff = compare(before, after);
  assert.equal(rebuild(before, diff), after);
  assert.equal(diff.rows[0].raw, before);
  assert.equal(visibleWhitespace(diff.rows[0].text), '<script>never_execute()</script>');
  assert.throws(() => compare(null, ""), TypeError);
});

test("100k-character adversarial and dense inputs take a complete-source fallback", { timeout: 3000 }, () => {
  for (const [before, after] of [["a\n".repeat(50000), "b\n".repeat(50000)],
    ["a\nb\n".repeat(25000), "b\na\n".repeat(25000)], ["", "\n".repeat(100000)],
    ["x".repeat(100000), "y".repeat(100000)]]) {
    const result = compare(before, after);
    if (result.mode === "full") {
      assert.equal(result.rows.length, 0);
      assert.ok(result.reason); assert.ok(result.added + result.removed > 0);
    } else assert.equal(rebuild(before, result), after, "A single very long line remains a bounded two-row diff");
  }
  const dense = compare("a\n".repeat(210), "b\n".repeat(210));
  assert.equal(dense.mode, "full"); assert.equal(dense.countsExact, true);
  assert.equal(dense.added, 210); assert.equal(dense.removed, 210);
  const large = compare("a\n".repeat(1000), "b\n".repeat(1000));
  assert.equal(large.mode, "full"); assert.equal(large.countsExact, false);
  assert.equal(compare("x".repeat(100001), "").mode, "full");
});

test("a large contextual view falls back without dropping any changed lines", () => {
  const before = Array.from({ length: 460 }, (_, i) => `original ${i}\n`).join("");
  const after = Array.from({ length: 460 }, (_, i) => `${i % 3 === 0 ? "changed" : "original"} ${i}\n`).join("");
  const diff = compare(before, after);
  assert.equal(diff.mode, "full"); assert.match(diff.reason, /too many rows/);
  assert.equal(diff.countsExact, true); assert.equal(diff.added, 154); assert.equal(diff.removed, 154);
  assert.deepEqual(diff.rows, []);
});

test("a tiny change in 100k lines keeps a compact complete diff", { timeout: 3000 }, () => {
  const before = "\n".repeat(99999), after = before.slice(0, 50000) + "x" + before.slice(50000);
  const diff = compare(before, after);
  assert.equal(diff.mode, "diff"); assert.ok(diff.rows.length <= 10);
  assert.equal(diff.added, 1); assert.equal(diff.removed, 1);
  assert.equal(rebuild(before, diff), after);
});

test("bounded randomized synthetic edits preserve complete source across repeated exact tokens", () => {
  let seed = 76543;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  const tokens = ["a\n", "a\r\n", "b\r", "\n", "😀\n", " x \n", "\t\n"];
  for (let run = 0; run < 1000; run++) {
    const make = () => Array.from({ length: random() % 20 }, () => tokens[random() % tokens.length]).join("") + (random() % 2 ? "tail" : "");
    const before = make(), after = make();
    assert.equal(rebuild(before, compare(before, after)), after, `Fixture ${run}`);
  }
});

test("browser-global diff is pure and does not touch environment capabilities", () => {
  const sandbox = {};
  for (const name of ["document", "fetch", "XMLHttpRequest", "WebSocket", "localStorage", "navigator", "eval", "Function"]) {
    Object.defineProperty(sandbox, name, { get() { throw new Error(`Forbidden capability ${name}`); } });
  }
  vm.runInNewContext(readFileSync(new URL("../../apps/web/proposal-diff.js", import.meta.url), "utf8"), sandbox, { timeout: 1000 });
  assert.equal(sandbox.VeyraProposalDiff.compare("a\r\n", "b\r").added, 1);
});
