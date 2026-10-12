"use strict";

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VeyraSavedLinks = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  const KEY = "veyra.saved-links.v1", MAX_LINKS = 1000, MAX_TIME = Date.parse("9999-12-31T23:59:59.999Z");
  const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const FIELDS = ["publication_id", "saved_title", "folder", "created_at", "updated_at"];
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function fail(message, status = 422, code = "INVALID_INPUT") {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
  }
  function data(object, key) {
    if (!record(object)) fail("Saved link details are required.");
    const property = Object.getOwnPropertyDescriptor(object, key);
    if (property && !own(property, "value")) fail("Saved link details must be plain data.");
    return property?.value;
  }
  function publicationId(value) {
    if (typeof value !== "string" || ID.exec(value)?.[0] !== value) fail("A valid public snapshot ID is required.");
    return value.toLowerCase();
  }
  function text(value, label, max, required = false, preserve = false) {
    if (typeof value !== "string") fail(`${label} must be text.`);
    const result = preserve ? value : value.trim();
    // Public titles keep exact server text, including format characters that JavaScript trim would erase.
    const blank = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/.test(result);
    if ((required && blank) || Array.from(result).length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      fail(`${label} must be ${required ? "1–" : "up to "}${max} characters without control characters.`);
    }
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} must contain valid Unicode text.`);
      } else if (code >= 0xdc00 && code <= 0xdfff) fail(`${label} must contain valid Unicode text.`);
    }
    return result;
  }
  function folder(value = "") {
    const result = text(value, "Folder", 80);
    if (/[\\/]/.test(result)) fail("Folder must be a single name without slashes.");
    return result;
  }
  function time(value) {
    return typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  function validateStored(value) {
    if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.links) || value.links.length > MAX_LINKS
      || Object.keys(value).length !== 3 || !own(value, "last_updated_at")
      || !(value.last_updated_at === null ? !value.links.length : time(value.last_updated_at))
      || Object.keys(value).some((key) => !["schema_version", "links", "last_updated_at"].includes(key))) throw new Error("Invalid saved links");
    const ids = new Set();
    for (const link of value.links) {
      if (!record(link) || Object.keys(link).length !== FIELDS.length || FIELDS.some((key) => !own(link, key))
        || publicationId(link.publication_id) !== link.publication_id || ids.has(link.publication_id)
        || text(link.saved_title, "Saved title", 120, true, true) !== link.saved_title || folder(link.folder) !== link.folder
        || !time(link.created_at) || !time(link.updated_at) || link.updated_at < link.created_at || link.updated_at > value.last_updated_at) throw new Error("Invalid saved link");
      ids.add(link.publication_id);
    }
    return value;
  }

  function create(storage) {
    if (storage === undefined) {
      try { storage = root.localStorage; } catch { storage = null; }
    }
    function read() {
      if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
        fail("Browser storage is unavailable. Saved links are only stored on this device.", 503, "STORAGE_UNAVAILABLE");
      }
      let raw;
      try { raw = storage.getItem(KEY); }
      catch { fail("Could not read saved links on this device. Existing data was left unchanged.", 503, "STORAGE_READ_FAILED"); }
      if (raw === null) return { schema_version: 1, links: [], last_updated_at: null };
      try {
        if (typeof raw !== "string" || raw.length > 1024 * 1024) throw new Error("Invalid saved links");
        return validateStored(JSON.parse(raw));
      } catch { fail("Saved link data is damaged or unsupported. It was left unchanged; do not clear browser storage if you need to recover it.", 500, "CORRUPT_STORAGE"); }
    }
    function advance(value) {
      // Persist the clock even after the last removal so an old review cannot match a newly saved link.
      const instant = Math.max(Date.now(), value.last_updated_at === null ? 0 : Date.parse(value.last_updated_at) + 1);
      if (!Number.isFinite(instant) || instant > MAX_TIME) {
        fail("Saved links were not changed. The saved-link clock is outside the supported range. Existing links can still be read.", 409, "STORAGE_CLOCK_LIMIT");
      }
      const stamp = new Date(instant).toISOString();
      value.last_updated_at = stamp;
      return stamp;
    }
    function write(value) {
      try { storage.setItem(KEY, JSON.stringify(value)); }
      catch { fail("Saved links were not changed. Browser storage may be full or blocked. Keep this review open and try again.", 507, "STORAGE_WRITE_FAILED"); }
    }
    function find(value, id) {
      const normalized = publicationId(id), link = value.links.find((item) => item.publication_id === normalized);
      if (!link) fail("This link is no longer saved on this device.", 404, "NOT_FOUND");
      return link;
    }
    function reviewed(link, input) {
      const expected = data(input, "expected_updated_at");
      if (!time(expected)) fail("Review the current saved link before changing it.");
      if (expected !== link.updated_at) fail("This saved link changed in another tab. Close this review and open it again.", 409, "LINK_CONFLICT");
    }
    return {
      listLinks() { return { links: read().links.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.publication_id.localeCompare(b.publication_id)) }; },
      getLink(id) { return find(read(), id); },
      saveLink(input) {
        const value = read(), id = publicationId(data(input, "publication_id"));
        const saved_title = text(data(input, "saved_title"), "Saved title", 120, true, true), name = folder(data(input, "folder"));
        const existing = value.links.find((link) => link.publication_id === id);
        if (existing) return existing;
        if (value.links.length >= MAX_LINKS) fail("This device has 1,000 saved links. Remove one before saving another.", 409, "LINK_LIMIT");
        const now = advance(value), link = { publication_id: id, saved_title, folder: name, created_at: now, updated_at: now };
        value.links.unshift(link);
        write(value);
        return link;
      },
      moveLink(id, input) {
        const value = read(), link = find(value, id);
        reviewed(link, input);
        const name = folder(data(input, "folder"));
        if (name === link.folder) return link;
        link.folder = name;
        link.updated_at = advance(value);
        write(value);
        return link;
      },
      removeLink(id, input) {
        const value = read(), link = find(value, id);
        reviewed(link, input);
        value.links = value.links.filter((item) => item !== link);
        advance(value);
        write(value);
        return { publication_id: link.publication_id, removed: true };
      },
    };
  }
  return { create };
});
