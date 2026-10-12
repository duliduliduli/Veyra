// Offline synthetic DOM fixtures only; no browser, server, network, or Python execution.
// NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/editor-accessibility-ui.mjs
// shortcut: jsdom cannot prove native Enter/Space activation, Tab traversal, touch, or screen-reader output; browser QA is still required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "saved-links.js", "proposal-diff.js", "strategy-backup.js", "backtest-params.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function boot(t, source = "abc", { open = true } = {}) {
  const errors = [], calls = [], virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#code/device", runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No DOM errors or unexpected fake requests"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w.navigator, "locks", { value: { request: async (_name, _options, operation) => operation() } });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url !== "/v1/catalog/datasets" || options.method && options.method !== "GET") errors.push(`Unexpected fake request ${url}`);
    return { ok: true, status: 200, json: async () => ({ datasets: [] }) };
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraWorkspaceStore.create(w.localStorage);
  const project = store.createProject({ name: "Keyboard fixture", files: { "strategy.py": source, "other.py": "# untouched\r\n" }, entrypoint: "strategy.py" });
  const second = store.createProject({ name: "Second fixture", files: { "strategy.py": "# second\r\n" }, entrypoint: "strategy.py" });
  w.eval(`${scripts.at(-1)}\nwindow.editorFixture = { state, route };`);
  await until(() => $("workspace-mode").textContent, "device library");
  async function navigate(hash) {
    w.location.hash = hash;
    await until(() => !$(`view-${hash.slice(1).split("/")[0]}`).hidden, hash);
    if (hash.startsWith("#project/")) await until(() => $("project-title").textContent !== "Loading strategy…", "project load");
    await delay(5);
  }
  if (open) await navigate(`#project/${project.id}`);
  const buttons = [...w.document.querySelectorAll("[data-key]")], editor = $("editor");
  const button = (text) => buttons.find((b) => b.dataset.key === text);
  const key = (key, options = {}, target = editor, type = "keydown") => {
    const event = new w.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event); return event;
  };
  const pointer = (target, type = "pointerdown", options = {}) => {
    const event = new w.MouseEvent(type, { button: 0, detail: type === "click" ? 1 : 0, bubbles: true, cancelable: true, ...options });
    for (const property of ["isPrimary", "pointerType"]) {
      if (Object.hasOwn(options, property)) Object.defineProperty(event, property, { value: options[property] });
    }
    target.dispatchEvent(event); return event;
  };
  const select = (start, end = start) => { editor.focus(); editor.setSelectionRange(start, end, "backward"); };
  const input = (id, value, type = "input") => { $(id).value = value; $(id).dispatchEvent(new w.Event(type, { bubbles: true })); };
  const state = w.editorFixture.state;
  const sourceText = (file = "strategy.py") => state.project.files[file];
  const draft = () => JSON.parse(w.localStorage.getItem(state.project.draftKey));
  return { w, $, editor, buttons, button, key, pointer, select, input, state, sourceText, draft, calls, project, second, store, navigate };
}

test("symbol controls use named native buttons; visible textarea help documents indentation and exit", async (t) => {
  const ui = await boot(t, "abc", { open: false });
  const group = ui.buttons[0].parentElement;
  assert.equal(group.getAttribute("role"), "group");
  assert.equal(group.getAttribute("aria-label"), "Insert symbol");
  for (const b of ui.buttons) {
    assert.equal(b.tagName, "BUTTON"); assert.equal(b.type, "button");
    assert.match(b.getAttribute("aria-label"), /insert /i);
    assert.equal(b.disabled, true); assert.equal(b.hasAttribute("tabindex"), false);
  }
  assert.match(ui.buttons[0].getAttribute("aria-label"), /^Tab/);
  assert.equal(ui.editor.getAttribute("aria-describedby"), "editor-keyboard-help");
  const help = ui.$("editor-keyboard-help");
  assert.equal(help.hidden, false); assert.equal(help.classList.contains("sr-only"), false);
  assert.match(help.textContent, /Tab inserts 4 spaces.*Escape, then Tab.*Shift\+Tab.*resets/);
  await ui.navigate(`#project/${ui.project.id}`);
  assert.ok(ui.buttons.every((b) => !b.disabled));
});

for (const activation of ["Enter", " "]) {
  test(`native ${activation === " " ? "Space" : activation} click path inserts each symbol exactly once at a preserved selection`, async (t) => {
    const ui = await boot(t);
    let inputs = 0; ui.editor.addEventListener("input", () => inputs++);
    for (const b of ui.buttons) {
      ui.input("editor", "abc"); ui.select(1, 2); b.focus();
      const before = ui.state.project.revision, emitted = inputs;
      assert.equal(ui.key(activation, {}, b).defaultPrevented, false);
      if (activation === " ") ui.key(activation, {}, b, "keyup");
      // Browser keyboard/assistive activation dispatches click; jsdom needs it supplied explicitly.
      b.click();
      if (activation !== " ") ui.key(activation, {}, b, "keyup");
      assert.equal(ui.sourceText(), `a${b.dataset.key}c`);
      assert.equal(ui.state.project.revision, before + 1);
      assert.equal(inputs, emitted + 1);
      assert.equal(ui.w.document.activeElement, ui.editor);
      assert.equal(ui.editor.selectionStart, 1 + b.dataset.key.length);
      assert.equal(ui.editor.selectionEnd, ui.editor.selectionStart);
      assert.equal(ui.draft().files["strategy.py"], ui.sourceText());
      assert.match(ui.$("draft-state").textContent, /Unsaved edits/);
    }
    assert.deepEqual(ui.calls, [{ url: "/v1/catalog/datasets", method: "GET" }]);
    assert.equal(ui.store.getProject(ui.project.id).latest_version_no, 1);
  });
}

test("primary pointerdown only preserves focus; pointerup and click insert once without duplicate input", async (t) => {
  const ui = await boot(t), b = ui.button(":");
  let inputs = 0; ui.editor.addEventListener("input", () => inputs++);
  for (const options of [{}, { isPrimary: true, pointerType: "touch" }, { isPrimary: true, pointerType: "pen" }]) {
    ui.input("editor", "abc"); ui.select(1, 2);
    const revision = ui.state.project.revision, emitted = inputs;
    assert.equal(ui.pointer(b, "pointerdown", options).defaultPrevented, true);
    assert.equal(ui.sourceText(), "abc"); assert.equal(inputs, emitted);
    assert.equal(ui.w.document.activeElement, ui.editor);
    ui.pointer(b, "pointerup", options); assert.equal(ui.sourceText(), "abc");
    ui.pointer(b, "click", options);
    assert.equal(ui.sourceText(), "a:c"); assert.equal(inputs, emitted + 1);
    assert.equal(ui.state.project.revision, revision + 1);
    assert.equal(ui.editor.selectionStart, 2); assert.equal(ui.editor.selectionEnd, 2);
  }
});

test("pointer cancellation, secondary buttons and nonprimary touch/pen presses do not insert; keyboard still works", async (t) => {
  const ui = await boot(t), b = ui.button("_"); ui.select(1);
  assert.equal(ui.pointer(b, "pointerdown", { button: 2 }).defaultPrevented, false);
  for (const pointerType of ["touch", "pen"]) {
    assert.equal(ui.pointer(b, "pointerdown", { isPrimary: false, pointerType }).defaultPrevented, false);
  }
  assert.equal(ui.sourceText(), "abc");
  ui.pointer(b); ui.pointer(b, "pointercancel");
  assert.equal(ui.sourceText(), "abc");
  ui.pointer(b, "click"); assert.equal(ui.sourceText(), "abc");
  b.focus(); b.click(); assert.equal(ui.sourceText(), "a_bc");
});

test("insertion preserves exact mixed line endings, Unicode, other files, draft bytes, and dirty tracking", async (t) => {
  const source = "# 😀\r\nx = 1\rvalue = 2\n# tail\r\n";
  const ui = await boot(t, source), index = ui.editor.value.indexOf("1");
  ui.select(index, index + 1); ui.button("_").focus(); ui.button("_").click();
  assert.equal(ui.sourceText(), source.replace("1", "_"));
  assert.equal(ui.draft().files["strategy.py"], source.replace("1", "_"));
  assert.equal(ui.sourceText("other.py"), "# untouched\r\n");
  assert.equal(ui.store.getVersion(ui.project.id, 1).files["strategy.py"], source);
  assert.equal(ui.editor.selectionStart, index + 1);
  assert.equal(ui.state.project.revision, 1);
  ui.input("editor", source); assert.equal(ui.sourceText(), source);
  assert.equal(ui.$("draft-state").textContent, "Saved"); assert.equal(ui.draft(), null);
});

test("replacing an identical symbol stays clean, while empty source accepts symbols and four-space Tab", async (t) => {
  const ui = await boot(t, "_"); ui.select(0, 1); ui.button("_").click();
  assert.equal(ui.state.project.revision, 0); assert.equal(ui.draft(), null);
  assert.equal(ui.$("draft-state").textContent, "Saved");
  ui.input("editor", ""); ui.select(0); ui.button("(").click(); assert.equal(ui.sourceText(), "(");
  ui.input("editor", ""); ui.select(0);
  assert.equal(ui.key("Tab").defaultPrevented, true); assert.equal(ui.sourceText(), "    ");
  assert.equal(ui.draft().files["strategy.py"], "    ");
});

test("Tab replaces the selected range with four spaces and retains untouched CRLF bytes", async (t) => {
  const ui = await boot(t, "one\r\ntwo\r\nthree\r\n"); ui.select(4, 7);
  assert.equal(ui.key("Tab").defaultPrevented, true);
  assert.equal(ui.sourceText(), "one\r\n    \r\nthree\r\n");
  assert.equal(ui.editor.selectionStart, 8); assert.equal(ui.editor.selectionEnd, 8);
  assert.equal(ui.draft().files["strategy.py"], ui.sourceText());
});

test("Escape then Tab releases one native forward traversal without editing; the next Tab indents", async (t) => {
  const ui = await boot(t); ui.select(1, 2);
  assert.equal(ui.key("Escape").defaultPrevented, true);
  assert.equal(ui.key("Tab").defaultPrevented, false, "Browser may perform its ordinary forward focus traversal");
  assert.equal(ui.sourceText(), "abc"); assert.equal(ui.state.project.revision, 0); assert.equal(ui.draft(), null);
  assert.equal(ui.editor.selectionStart, 1); assert.equal(ui.editor.selectionEnd, 2);
  assert.equal(ui.key("Tab").defaultPrevented, true, "The escape is consumed even when synthetic Tab does not move focus");
  assert.equal(ui.sourceText(), "a    c");
});

for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
  test(`${modifier} Tab and Escape keep their native behavior and do not arm an exit`, async (t) => {
    const ui = await boot(t); ui.select(0);
    assert.equal(ui.key("Tab", { [modifier]: true }).defaultPrevented, false);
    assert.equal(ui.key("Escape", { [modifier]: true }).defaultPrevented, false);
    assert.equal(ui.sourceText(), "abc"); assert.equal(ui.state.project.revision, 0);
    assert.equal(ui.key("Tab").defaultPrevented, true); assert.equal(ui.sourceText(), "    abc");
  });
}

for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`composition ${JSON.stringify(composing)} does not indent or arm Escape`, async (t) => {
    const ui = await boot(t); ui.select(0);
    assert.equal(ui.key("Tab", composing).defaultPrevented, false);
    assert.equal(ui.key("Escape", composing).defaultPrevented, false);
    assert.equal(ui.sourceText(), "abc");
    assert.equal(ui.key("Tab").defaultPrevented, true); assert.equal(ui.sourceText(), "    abc");
  });
}

test("another key, blur/return, pointer selection, input, and composition start reset the Escape sequence", async (t) => {
  const ui = await boot(t);
  for (const interrupt of [() => ui.key("ArrowRight"), () => { ui.button("_").focus(); ui.editor.focus(); },
    () => ui.pointer(ui.editor), () => ui.editor.dispatchEvent(new ui.w.Event("input")),
    () => ui.editor.dispatchEvent(new ui.w.CompositionEvent("compositionstart"))]) {
    ui.input("editor", "abc"); ui.select(0); ui.key("Escape"); interrupt();
    assert.equal(ui.key("Tab").defaultPrevented, true); assert.equal(ui.sourceText(), "    abc");
  }
});

test("source-file switching away and back invalidates both an armed exit and a pending pointer click", async (t) => {
  const ui = await boot(t), b = ui.button("_"); ui.select(1); ui.key("Escape"); ui.pointer(b);
  ui.input("editor-file", "other.py", "change"); ui.input("editor-file", "strategy.py", "change");
  ui.pointer(b, "click"); assert.equal(ui.sourceText(), "abc");
  ui.select(0); assert.equal(ui.key("Tab").defaultPrevented, true); assert.equal(ui.sourceText(), "    abc");
});

test("a newer edit invalidates a pending pointer click and resets the exit", async (t) => {
  const ui = await boot(t), b = ui.button("_"); ui.select(1); ui.key("Escape"); ui.pointer(b);
  ui.input("editor", "newer\n"); ui.pointer(b, "click");
  assert.equal(ui.sourceText(), "newer\n"); assert.equal(ui.state.project.revision, 1);
  assert.equal(ui.key("Tab").defaultPrevented, true); assert.equal(ui.state.project.revision, 2);
});

test("project replacement and same-route reopening invalidate pending clicks and the Escape sequence", async (t) => {
  const ui = await boot(t), b = ui.button("_"); ui.select(1); ui.key("Escape"); ui.pointer(b);
  await ui.navigate(`#project/${ui.second.id}`);
  ui.pointer(b, "click"); assert.equal(ui.sourceText(), "# second\r\n");
  ui.select(0); assert.equal(ui.key("Tab").defaultPrevented, true);
  ui.input("editor", "# second\n"); ui.select(0); ui.key("Escape"); ui.pointer(b);
  const before = ui.state.project; ui.w.editorFixture.route();
  await until(() => ui.state.project && ui.state.project !== before, "same-route reopening");
  ui.pointer(b, "click"); assert.equal(ui.sourceText(), "# second\r\n");
  ui.select(0); assert.equal(ui.key("Tab").defaultPrevented, true);
});

test("missing project, missing file, disabled/read-only editor, hidden view and new hash cannot edit", async (t) => {
  const ui = await boot(t), b = ui.button("_"); ui.select(0);
  const p = ui.state.project;
  for (const [invalidate, restore] of [
    [() => { ui.state.project = null; }, () => { ui.state.project = p; }],
    [() => { delete p.files["strategy.py"]; }, () => { p.files["strategy.py"] = "abc"; }],
    [() => { ui.editor.disabled = true; }, () => { ui.editor.disabled = false; }],
    [() => { ui.editor.readOnly = true; }, () => { ui.editor.readOnly = false; }],
    [() => { ui.$("view-project").hidden = true; }, () => { ui.$("view-project").hidden = false; }],
  ]) {
    invalidate(); b.click(); assert.equal(ui.editor.value, "abc");
    assert.equal(ui.key("Tab").defaultPrevented, false); assert.equal(p.revision, 0); restore();
  }
  ui.w.location.hash = "#code/device";
  b.click(); assert.equal(ui.editor.value, "abc"); assert.equal(p.revision, 0);
  await until(() => ui.state.project === null, "left project route");
  b.click(); assert.equal(ui.editor.value, "abc");
});

test("failed project loading disables native symbol buttons and cannot modify the old source", async (t) => {
  const ui = await boot(t); ui.select(0);
  await ui.navigate("#project/local-11111111-1111-4111-8111-111111111111");
  assert.equal(ui.$("project-title").textContent, "Strategy unavailable");
  assert.equal(ui.editor.disabled, true); assert.ok(ui.buttons.every((b) => b.disabled));
  ui.button("_").click(); ui.key("Tab"); assert.equal(ui.editor.value, "abc");
  assert.equal(ui.store.getVersion(ui.project.id, 1).files["strategy.py"], "abc");
});

for (const modifier of ["ctrlKey", "metaKey"]) {
  test(`${modifier}+S still explicitly saves the draft and clears a pending Escape sequence`, async (t) => {
    const ui = await boot(t); ui.input("editor", "# changed\n"); ui.select(0); ui.key("Escape");
    assert.equal(ui.key("s", { [modifier]: true }).defaultPrevented, true);
    await until(() => ui.$("project-version").textContent === "saved v2", "explicit save");
    assert.equal(ui.$("draft-state").textContent, "Saved");
    assert.equal(ui.store.getVersion(ui.project.id, 2).files["strategy.py"], "# changed\n");
    assert.equal(ui.key("Tab").defaultPrevented, true);
    assert.deepEqual(ui.calls, [{ url: "/v1/catalog/datasets", method: "GET" }]);
  });
}
