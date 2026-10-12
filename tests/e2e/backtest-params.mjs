// Pure JSON input checks; no DOM, HTTP, strategy execution or database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const { parse } = createRequire(import.meta.url)("../../apps/web/backtest-params.js");
const nested = depth => '{"x":'.repeat(depth) + '0' + '}'.repeat(depth);

test("valid JSON values are preserved, including Unicode, escaped controls and exact large strings", () => {
  const text = '{"fast":10,"nested":[null,true,false,{},[],0,-42,1.25,0.00001,9007199254740991,-9007199254740991,"9007199254740993","é😀\\t\\n\\r\\b\\f\\u0001"],"__proto__":{"label":"data"},"constructor":3}';
  assert.deepEqual(parse(text), JSON.parse(text));
  assert.deepEqual(JSON.parse(JSON.stringify(parse(text))), JSON.parse(text));
  assert.equal(Object.hasOwn(parse(text), "__proto__"), true);
  assert.deepEqual(parse(""), {});
});

for (const text of ["null", "[]", "1", "true", '"text"']) test(`root must be an object: ${text}`, () => {
  assert.throws(() => parse(text), /JSON object/);
});
for (const text of ['{"x":1e999}', '{"nested":[-1e999]}']) test(`nonfinite numbers cannot become null: ${text}`, () => {
  assert.throws(() => parse(text), /finite/);
});
for (const number of ["9007199254740992", "9007199254740993", "-9007199254740993", "1e100", "9.007199254740993e15"]) {
  test(`unsafe numeric integer is rejected with string guidance: ${number}`, () => {
    assert.throws(() => parse(`{"nested":[{"x":${number}}]}`), /integers.*strings/);
  });
}
for (const text of ['{"x":"\\ud800"}', '{"\\udfff":"x"}', '{"x":"\\u0000"}', '{"\\u0000":1}']) {
  test(`invalid Unicode and NUL are rejected: ${text}`, () => assert.throws(() => parse(text), /Unicode without NUL/));
}
for (const text of ['{"x":NaN}', '{"x":Infinity}', '{"x":}', '{"x":"\n"}', ' ']) {
  test(`invalid JSON syntax is rejected: ${JSON.stringify(text)}`, () => assert.throws(() => parse(text), /valid JSON/));
}

test("container depth includes empty nested arrays and objects, but not scalar leaves", () => {
  assert.deepEqual(parse(nested(16)), JSON.parse(nested(16)));
  assert.throws(() => parse(nested(17)), /16 objects or arrays/);
  assert.doesNotThrow(() => parse('{"x":' + '['.repeat(15) + '0' + ']'.repeat(15) + '}'));
  assert.throws(() => parse('{"x":' + '['.repeat(16) + ']'.repeat(16) + '}'), /16 objects or arrays/);
});
for (const [char, count] of [["x", 8184], ["é", 4092], ["😀", 2046], ["\u0001", 1364], ['"', 4092], ["\\", 4092]]) {
  test(`8 KiB accounting uses compact UTF-8 bytes: ${char}`, () => {
    assert.doesNotThrow(() => parse(JSON.stringify({ x: char.repeat(count) })));
    assert.throws(() => parse(JSON.stringify({ x: char.repeat(count + 1) })), /8 KiB/);
  });
}
test("bounded raw input permits whitespace while limiting work before parsing", () => {
  assert.deepEqual(parse(" ".repeat(32766) + "{}"), {});
  assert.throws(() => parse(" ".repeat(32767) + "{}"), /32 KiB/);
  assert.throws(() => parse('"é"'.repeat(16384)), /32 KiB/);
  assert.throws(() => parse("[".repeat(40000)), /32 KiB/);
});

test("normal binary64 parsing remains explicit; exact decimal text belongs in strings", () => {
  assert.deepEqual(parse('{"value":9007199254740990.9,"exact":"9007199254740990.9"}'),
    { value: 9007199254740991, exact: "9007199254740990.9" });
});
