"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VeyraStrategyBackup = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FORMAT = "veyra-strategy-snapshot", SCHEMA_VERSION = 1;
  const LIMITS = Object.freeze({ files: 50, sourceBytes: 256 * 1024, pathBytes: 256,
    jsonBytes: 2 * 1024 * 1024, name: 120, description: 2000, folder: 80 });
  const FIELDS = ["format", "schema_version", "name", "description", "folder", "entrypoint", "files", "has_unsaved_changes"];
  const PATH = /^[A-Za-z0-9_][A-Za-z0-9_\-]*(\/[A-Za-z0-9_][A-Za-z0-9_\-]*)*\.py$/;
  const UNSAFE = new Set(["__proto__", "prototype", "constructor"]);
  const encoder = new TextEncoder();
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function fail(message) {
    const error = new Error(message);
    error.status = 422;
    error.code = "INVALID_STRATEGY_BACKUP";
    throw error;
  }

  function record(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
    if (Object.keys(value).some((key) => UNSAFE.has(key))) fail("Unsafe object key in strategy backup");
    return value;
  }

  function value(object, key) {
    const property = Object.getOwnPropertyDescriptor(object, key);
    if (property && !own(property, "value")) fail("Strategy backup fields must be plain data");
    return property?.value;
  }

  function bytes(text, label, max) {
    if (typeof text !== "string") fail(`${label} must be text`);
    if (text.length > max) fail(`${label} exceeds its size limit`);
    // TextEncoder replaces lone surrogates; reject them to match Python's strict UTF-8 encoding.
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} must contain valid UTF-8 text`);
      } else if (code >= 0xdc00 && code <= 0xdfff) fail(`${label} must contain valid UTF-8 text`);
    }
    const size = encoder.encode(text).length;
    if (size > max) fail(`${label} exceeds its size limit`);
    return size;
  }

  function field(text, label, max, multiline = false) {
    bytes(text, label, max * 4);
    if ((multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(text)) {
      fail(`${label} contains control characters`);
    }
    const result = text.trim();
    if (result.length > max) fail(`${label} exceeds ${max} characters`);
    return result;
  }

  function snapshot(input) {
    record(input, "Strategy snapshot");
    const name = field(value(input, "name"), "Name", LIMITS.name);
    const description = field(value(input, "description") ?? "", "Description", LIMITS.description, true);
    const folder = field(value(input, "folder") ?? "", "Folder", LIMITS.folder);
    if (!name) fail("Name is required");
    if (/[\\/]/.test(folder) || folder === "." || folder === "..") fail("Folder must be a flat name, not a path");
    const originalFiles = record(value(input, "files"), "Python files"), paths = Object.keys(originalFiles);
    if (!paths.length || paths.length > LIMITS.files) fail(`Between 1 and ${LIMITS.files} Python files are required`);
    const files = {};
    let sourceBytes = 0;
    for (const path of paths) {
      if (path.length > LIMITS.pathBytes) fail(`Python file paths must be at most ${LIMITS.pathBytes} ASCII bytes`);
      if (PATH.exec(path)?.[0] !== path) fail("Invalid Python file path in strategy backup");
      const source = value(originalFiles, path);
      sourceBytes += bytes(source, "Python source", LIMITS.sourceBytes);
      if (sourceBytes > LIMITS.sourceBytes) fail("Strategy exceeds 256 KiB of Python source");
      files[path] = source;
    }
    const entrypoint = value(input, "entrypoint"), has_unsaved_changes = value(input, "has_unsaved_changes");
    if (typeof entrypoint !== "string" || !own(files, entrypoint)) fail("Entrypoint must be one of the Python files");
    if (typeof has_unsaved_changes !== "boolean") fail("The unsaved-changes flag must be true or false");
    return { name, description, folder, files: Object.freeze(files), entrypoint, has_unsaved_changes, sourceBytes };
  }

  function exportJSON(input) {
    // Select only portable snapshot fields, never spread the project's IDs or saved history.
    const { sourceBytes, ...content } = snapshot(input);
    const json = JSON.stringify({ format: FORMAT, schema_version: SCHEMA_VERSION, ...content }, null, 2) + "\n";
    bytes(json, "Strategy backup", LIMITS.jsonBytes);
    return json;
  }

  function readText(input) {
    if (typeof input === "string") {
      bytes(input, "Strategy backup", LIMITS.jsonBytes);
      return input;
    }
    if (input instanceof ArrayBuffer) input = new Uint8Array(input);
    if (!(input instanceof Uint8Array)) fail("Strategy backup must be JSON text or UTF-8 bytes");
    if (input.byteLength > LIMITS.jsonBytes) fail("Strategy backup exceeds its size limit");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input); }
    catch { fail("Strategy backup must contain valid UTF-8 text"); }
  }

  function checkKeys(text) {
    // JSON.parse discards duplicate keys. Inspect only keys/containers first; it still parses the grammar.
    const stack = [];
    for (let i = 0; i < text.length;) {
      const token = text[i++];
      if (token === "\"") {
        const start = i - 1;
        while (i < text.length) {
          const char = text[i++];
          if (char === "\\") i++;
          else if (char === "\"") break;
        }
        let next = i;
        while (/[ \t\r\n]/.test(text[next] || "x")) next++;
        if (text[next] === ":") {
          let key;
          try { key = JSON.parse(text.slice(start, i)); }
          catch { fail("Strategy backup is not valid JSON"); }
          const keys = stack[stack.length - 1];
          if (!keys) fail("Strategy backup is not valid JSON");
          if (UNSAFE.has(key)) fail("Unsafe object key in strategy backup");
          if (keys.has(key)) fail("Duplicate object key in strategy backup");
          keys.add(key);
          if (keys.size > LIMITS.files) fail("Too many fields in strategy backup");
        }
      } else if (token === "{") {
        stack.push(new Set());
        if (stack.length > 2) fail("Strategy backup is nested too deeply");
      } else if (token === "}") stack.pop();
      else if (token === "[" || token === "]") fail("Arrays are not supported in strategy backups");
    }
  }

  function importJSON(input) {
    const text = readText(input);
    checkKeys(text);
    let archive;
    try { archive = JSON.parse(text); }
    catch { fail("Strategy backup is not valid JSON"); }
    record(archive, "Strategy backup");
    if (Object.keys(archive).length !== FIELDS.length || FIELDS.some((key) => !own(archive, key))) {
      fail("Strategy backup has missing or unsupported fields");
    }
    if (archive.format !== FORMAT || archive.schema_version !== SCHEMA_VERSION) fail("Unsupported strategy backup format or schema version");
    if (typeof archive.description !== "string" || typeof archive.folder !== "string") fail("Strategy backup metadata must be text");
    const { has_unsaved_changes, sourceBytes, ...content } = snapshot(archive);
    if (["name", "description", "folder"].some((key) => archive[key] !== content[key])) {
      fail("Strategy backup metadata must not have outer whitespace");
    }
    return Object.freeze({ mode: "create-private-local", project: Object.freeze({ ...content, visibility: "private" }),
      has_unsaved_changes, file_count: Object.keys(content.files).length, source_bytes: sourceBytes, history_included: false });
  }

  return Object.freeze({ FORMAT, SCHEMA_VERSION, LIMITS, exportJSON, importJSON });
});
