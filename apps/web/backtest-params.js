"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VeyraBacktestParams = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_BYTES = 8192, MAX_DEPTH = 16, MAX_TEXT_BYTES = 32768;
  const encoder = new TextEncoder();
  const object = value => value !== null && typeof value === "object";

  function parse(text) {
    if (encoder.encode(text).length > MAX_TEXT_BYTES) throw new Error("Parameter JSON text must be at most 32 KiB.");
    let params;
    try { params = JSON.parse(text || "{}"); } catch {
      throw new Error('Parameters must be valid JSON, for example {"fast": 10}.');
    }
    if (!object(params) || Array.isArray(params)) throw new Error("Parameters must be a JSON object.");
    function string(value) {
      for (const char of value) {
        const code = char.codePointAt(0);
        if (code === 0 || (code >= 0xD800 && code <= 0xDFFF)) {
          throw new Error("Parameter names and strings must contain valid Unicode without NUL characters.");
        }
      }
    }
    function visit(value, depth) {
      if (object(value)) {
        if (depth > MAX_DEPTH) throw new Error("Parameters must nest at most 16 objects or arrays, including the root.");
        for (const [key, child] of Object.entries(value)) { string(key); visit(child, depth + 1); }
      } else if (typeof value === "string") string(value);
      else if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("Parameter numbers must be finite.");
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
          throw new Error("Parameter integers must be within ±9007199254740991; use strings for exact larger values.");
        }
      }
    }
    visit(params, 1);
    if (encoder.encode(JSON.stringify(params)).length > MAX_BYTES) {
      throw new Error("Parameters must serialize to at most 8 KiB of UTF-8 JSON.");
    }
    return params;
  }

  return { parse };
});
