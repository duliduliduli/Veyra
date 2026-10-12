"use strict";

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VeyraWorkspaceStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  const KEY = "veyra.workspace.v1";
  const PATH = /^[A-Za-z0-9_][A-Za-z0-9_\-]*(\/[A-Za-z0-9_][A-Za-z0-9_\-]*)*\.py$/;
  const ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  function fail(message, status = 422, code = "INVALID_INPUT") {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
  }

  function field(value, label, max, required = false) {
    if (typeof value !== "string") fail(`${label} must be text`);
    const trimmed = value.trim();
    if ((required && !trimmed) || trimmed.length > max) {
      fail(`${label} must be ${required ? "between 1 and" : "at most"} ${max} characters`);
    }
    return trimmed;
  }

  function metadata(input) {
    if (!record(input)) fail("Project details are required");
    const name = field(input.name, "Name", 120, true);
    const description = field(input.description ?? "", "Description", 2000);
    const folder = field(input.folder ?? "", "Folder", 80);
    if (/[\\/]/.test(folder)) fail("Folder must be a single name without slashes");
    return { name, description, folder };
  }

  function dataValue(object, key) {
    const property = Object.getOwnPropertyDescriptor(object, key);
    if (property && !own(property, "value")) fail("Snapshot fields must be plain data");
    return property?.value;
  }

  function validateFilePath(path) {
    if (typeof path !== "string" || path.length > 256 || PATH.exec(path)?.[0] !== path) {
      fail("Use a relative .py path up to 256 characters, with letters, numbers, underscores, hyphens and optional folders");
    }
    return path;
  }

  function snapshot(input) {
    if (!record(input)) fail("Python files are required");
    const files = dataValue(input, "files");
    if (!record(files)) fail("Python files are required");
    const entries = Object.keys(files).map((path) => [path, dataValue(files, path)]);
    if (!entries.length || entries.length > 50) fail("Between 1 and 50 files are required");
    let total = 0;
    const encoder = new TextEncoder();
    for (const [path, content] of entries) {
      // Existing long paths stay readable; the new-path control has the portable 256-byte limit.
      if (PATH.exec(path)?.[0] !== path) fail(`Invalid Python file path: ${path}`);
      if (typeof content !== "string") fail(`File content must be text: ${path}`);
      for (let i = 0; i < content.length; i++) {
        const code = content.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = content.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) fail("Python source must contain valid UTF-8 text");
        } else if (code >= 0xdc00 && code <= 0xdfff) fail("Python source must contain valid UTF-8 text");
      }
      total += encoder.encode(content).length;
    }
    if (total > 256 * 1024) fail("Project exceeds 256 KiB of Python source");
    const supplied = dataValue(input, "entrypoint"), entrypoint = supplied === undefined ? "strategy.py" : supplied;
    if (typeof entrypoint !== "string" || !own(files, entrypoint)) {
      fail("Entrypoint must be one of the files");
    }
    return { files: Object.fromEntries(entries), entrypoint };
  }

  function uuid() {
    const crypto = root.crypto || (typeof require === "function" ? require("node:crypto") : null);
    if (crypto?.randomUUID) return `local-${crypto.randomUUID()}`;
    if (!crypto?.getRandomValues) fail("Secure random IDs are unavailable in this browser", 503, "SECURE_RANDOM_UNAVAILABLE");
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `local-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  const summary = ({ versions, ...project }) => project;
  const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

  function validateStored(data) {
    if (!record(data) || data.schema_version !== 1 || !Array.isArray(data.projects)) throw new Error("Invalid workspace");
    const ids = new Set(), names = new Set();
    for (const project of data.projects) {
      const normalized = metadata(project);
      if (Object.entries(normalized).some(([key, value]) => project[key] !== value)
        || !ID.test(project.id) || ids.has(project.id) || names.has(project.name)
        || project.visibility !== "private" || !validTime(project.created_at) || !validTime(project.updated_at)
        || !Array.isArray(project.versions) || !project.versions.length) throw new Error("Invalid project");
      ids.add(project.id);
      names.add(project.name);
      for (const [index, version] of project.versions.entries()) {
        if (!record(version) || !ID.test(version.id) || ids.has(version.id) || version.project_id !== project.id
          || version.version_no !== project.versions.length - index || version.content_hash !== null
          || !validTime(version.created_at)) throw new Error("Invalid version");
        const content = snapshot(version);
        if (content.entrypoint !== version.entrypoint) throw new Error("Invalid entrypoint");
        ids.add(version.id);
      }
      if (project.latest_version_id !== project.versions[0].id
        || project.latest_version_no !== project.versions[0].version_no) throw new Error("Invalid latest version");
    }
    return data;
  }

  function create(storage) {
    if (storage === undefined) {
      try { storage = root.localStorage; } catch { storage = null; }
    }

    function read() {
      if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
        fail("Browser storage is unavailable. Enable local storage to save strategies on this device.", 503, "STORAGE_UNAVAILABLE");
      }
      let raw;
      try { raw = storage.getItem(KEY); }
      catch { fail("Could not read browser storage. Saved strategies were left unchanged.", 503, "STORAGE_READ_FAILED"); }
      if (raw === null) return { schema_version: 1, projects: [] };
      try { return validateStored(JSON.parse(raw)); }
      catch { fail("Saved strategy data is damaged or unsupported. It was left unchanged; do not clear browser storage if you need to recover it.", 500, "CORRUPT_STORAGE"); }
    }

    function write(data) {
      // One atomic storage write keeps existing revisions intact if the browser rejects the save.
      try { storage.setItem(KEY, JSON.stringify(data)); }
      catch { fail("Strategy was not saved. Browser storage may be full or blocked. Keep your changes open and try again.", 507, "STORAGE_WRITE_FAILED"); }
    }

    function find(data, id) {
      const project = data.projects.find((item) => item.id === id);
      if (!project) fail("Strategy not found on this device", 404, "NOT_FOUND");
      return project;
    }

    function unique(data, name, exceptId) {
      if (data.projects.some((project) => project.name === name && project.id !== exceptId)) {
        fail("A strategy with that name already exists on this device", 409, "NAME_CONFLICT");
      }
    }

    function add(data, input) {
      const details = metadata(input), content = snapshot(input);
      unique(data, details.name);
      const id = uuid(), now = new Date().toISOString();
      const version = { id: uuid(), project_id: id, version_no: 1, content_hash: null,
        ...content, created_at: now };
      const project = { id, ...details, visibility: "private", created_at: now, updated_at: now,
        latest_version_id: version.id, latest_version_no: 1, versions: [version] };
      data.projects.unshift(project);
      write(data);
      return { ...summary(project), latest_version: version };
    }

    return {
      listProjects() {
        return { projects: read().projects.map(summary).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) };
      },
      createProject(input) { return add(read(), input); },
      getProject(id) { return find(read(), id); },
      getVersion(id, number) {
        const project = find(read(), id);
        const version = project.versions.find((item) => item.version_no === number);
        if (!version) fail("Strategy version not found on this device", 404, "NOT_FOUND");
        return version;
      },
      saveVersion(id, input) {
        const data = read(), project = find(data, id);
        if (!record(input) || !Number.isInteger(input.expected_version_no) || input.expected_version_no < 1) {
          fail("The expected version number is required to save safely");
        }
        // shortcut: localStorage has no cross-tab transaction; coordinate tabs before simultaneous writes become a supported workflow.
        if (input.expected_version_no !== project.latest_version_no) {
          fail("This strategy changed in another tab. Reopen the latest version before saving your changes.", 409, "VERSION_CONFLICT");
        }
        const content = snapshot(input), now = new Date().toISOString();
        const version = { id: uuid(), project_id: id, version_no: project.latest_version_no + 1,
          content_hash: null, ...content, created_at: now };
        project.versions.unshift(version);
        project.latest_version_id = version.id;
        project.latest_version_no = version.version_no;
        project.updated_at = now;
        write(data);
        return version;
      },
      updateProject(id, input) {
        const data = read(), project = find(data, id);
        if (!record(input)) fail("Project details are required");
        const details = metadata({ ...project, ...Object.fromEntries(["name", "description", "folder"]
          .filter((key) => own(input, key)).map((key) => [key, input[key]])) });
        unique(data, details.name, id);
        Object.assign(project, details, { updated_at: new Date().toISOString() });
        write(data);
        return summary(project);
      },
      duplicateProject(id, input = {}) {
        const data = read(), project = find(data, id);
        if (!record(input)) fail("Project details are required");
        if (input.expected_version_no !== undefined) {
          if (!Number.isInteger(input.expected_version_no) || input.expected_version_no < 1 || input.expected_version_no > 2147483647) {
            fail("The expected version number must be a positive integer");
          }
          if (input.expected_version_no !== project.latest_version_no) {
            fail("This strategy changed in another tab. Reopen the latest version before duplicating it.", 409, "VERSION_CONFLICT");
          }
        }
        let name = input.name;
        if (name === undefined) {
          let number = 1;
          do {
            const suffix = number === 1 ? " copy" : ` copy ${number}`;
            name = project.name.slice(0, 120 - suffix.length).trimEnd() + suffix;
            number += 1;
          } while (data.projects.some((item) => item.name === name));
        }
        return add(data, { name, description: project.description, folder: project.folder,
          files: project.versions[0].files, entrypoint: project.versions[0].entrypoint });
      },
    };
  }

  return { create, validateSnapshot: snapshot, validateFilePath };
});
