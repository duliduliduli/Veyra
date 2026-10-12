// Offline synthetic DOM fixtures only; no browser/server, live API, source execution or external writes.
// NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/proposal-diff-ui.mjs
// shortcut: actual layout, native keyboard scrolling and assistive-technology output need browser QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "chart-tools.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "saved-links.js", "proposal-diff.js", "strategy-backup.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function boot(t, source) {
  const errors = [], calls = [], virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#code/device", runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No DOM errors or unexpected requests"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url !== "/v1/catalog/datasets" || options.method && options.method !== "GET") errors.push(`Unexpected fake request ${url}`);
    return { ok: true, status: 200, json: async () => ({ datasets: [] }) };
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const initial = typeof source === "function" ? source(w) : source;
  const store = w.VeyraWorkspaceStore.create(w.localStorage), project = store.createProject({ name: "Proposal fixture",
    files: { "strategy.py": initial, "other.py": "# untouched\r\n" }, entrypoint: "strategy.py" });
  w.eval(`${scripts.at(-1)}\nwindow.fixtureState = state;
    window.fixtureReview = (before, after) => {
      assistantProposal = { proposal: { base_code: before, proposed_code: after } };
      reviewAssistantProposal();
    };`);
  await until(() => $("workspace-mode").textContent, "device library");
  w.location.hash = `#project/${project.id}`;
  await until(() => !$("editor").disabled && !$("view-project").hidden, "fixture editor");
  const input = (id, value, event = "input") => { $(id).value = value; $(id).dispatchEvent(new w.Event(event, { bubbles: true })); };
  const ask = (prompt) => { input("assistant-prompt", prompt); $("assistant-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); };
  const current = () => w.fixtureState.project.files["strategy.py"];
  const storage = () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => {
    const key = w.localStorage.key(i); return [key, w.localStorage.getItem(key)];
  }));
  return { w, $, ask, input, current, storage, calls, initial, store, project };
}

test("offline parameter review shows compact complete changes, source access and accessible labels without mutation", async (t) => {
  const ui = await boot(t, (w) => w.VeyraStudioAssistant.templates.sma_cross.replace(/\n/g, "\r\n"));
  const storage = ui.storage(), calls = [...ui.calls];
  ui.ask("set fast to 12");
  assert.match(ui.$("assistant-diff-summary").textContent, /\+1 added \/ −1 removed/);
  assert.equal(ui.$("assistant-proposal").hidden, false);
  assert.equal(ui.$("assistant-diff-review").hidden, false);
  assert.equal(ui.$("assistant-full-source").open, false);
  assert.equal(ui.$("assistant-before").textContent, ui.initial);
  assert.equal(ui.$("assistant-after").textContent, ui.initial.replace('"fast", 10', '"fast", 12'));
  assert.equal(ui.$("assistant-diff-lines").querySelectorAll(".proposal-add").length, 1);
  assert.equal(ui.$("assistant-diff-lines").querySelectorAll(".proposal-remove").length, 1);
  assert.ok(ui.$("assistant-diff-lines").querySelectorAll(".proposal-gap").length > 0);
  assert.match(ui.$("assistant-diff-lines").textContent, /CRLF/);
  assert.match(ui.$("assistant-diff-lines").textContent, /Added, proposed line/);
  assert.match(ui.$("assistant-diff-lines").textContent, /Removed, line before proposal/);
  assert.equal(ui.$("assistant-diff-scroll").getAttribute("tabindex"), "0");
  assert.equal(ui.$("assistant-diff-scroll").getAttribute("aria-describedby"), "assistant-diff-legend");
  assert.equal(ui.$("assistant-before").getAttribute("aria-labelledby"), "assistant-before-title");
  assert.equal(ui.$("assistant-after").getAttribute("tabindex"), "0");
  assert.match(ui.$("assistant-diff-lines").querySelector(".proposal-add code").textContent, /·/);
  ui.$("assistant-show-whitespace").click();
  assert.match(ui.$("assistant-diff-lines").querySelector(".proposal-add code").textContent, /            fast = config.get/);
  ui.$("assistant-full-source").open = true;
  assert.equal(ui.current(), ui.initial); assert.deepEqual(ui.storage(), storage); assert.deepEqual(ui.calls, calls);
  assert.match(ui.$("assistant-title").parentElement.parentElement.textContent, /No AI model is connected/);
  assert.match(ui.$("assistant-diff-note").textContent, /Only unchanged lines may be omitted/);
  assert.match(ui.$("assistant-review-warning").textContent, /indentation changes can change Python behavior/);
  assert.match(ui.$("assistant-review-warning").textContent, /has not validated or run the code/);
});

const legacy = JSON.parse(readFileSync(new URL("../fixtures/studio_templates_v1.json", import.meta.url), "utf8"));
for (const [name, command] of [["buy_hold", "create buy and hold"], ["sma_cross", "create SMA crossover"]]) {
  for (const ending of ["LF", "CRLF"]) {
    test(`saved v1 ${name} ${ending} stays exact across parameter preview, Apply, Undo and explicit replacement`, async (t) => {
      const original = ending === "CRLF" ? legacy[name].replace(/\n/g, "\r\n") : legacy[name];
      const ui = await boot(t, original), storage = ui.storage();
      assert.equal(ui.current(), original);
      ui.ask("set alloc to 0.5");
      const changed = original.replace('"alloc", "0.95"', '"alloc", "0.5"');
      assert.equal(ui.$("assistant-before").textContent, original);
      assert.equal(ui.$("assistant-after").textContent, changed);
      assert.match(ui.$("assistant-diff-summary").textContent, /\+1 added \/ −1 removed/);
      assert.equal(ui.current(), original); assert.deepEqual(ui.storage(), storage);
      ui.$("assistant-apply").click(); assert.equal(ui.current(), changed);
      assert.equal(ui.store.getVersion(ui.project.id, 1).files["strategy.py"], original);
      ui.$("assistant-undo").click(); assert.equal(ui.current(), original);
      ui.ask(command);
      assert.equal(ui.current(), original);
      assert.equal(ui.$("assistant-after").textContent, ui.w.VeyraStudioAssistant.templates[name]);
      ui.$("assistant-apply").click(); assert.equal(ui.current(), ui.w.VeyraStudioAssistant.templates[name]);
      ui.$("assistant-undo").click(); assert.equal(ui.current(), original);
      assert.equal(ui.w.fixtureState.project.files["other.py"], "# untouched\r\n");
      assert.equal(ui.store.getVersion(ui.project.id, 1).files["strategy.py"], original);
      assert.equal(ui.calls.some((call) => call.method !== "GET"), false);
    });
  }
}

test("Apply and Undo keep exact mixed endings, final-newline state and Unicode; repeated Apply has no extra effect", async (t) => {
  const ui = await boot(t, '# 😀é\r\nvalue = "☀"\r# last line without newline');
  ui.ask("create blank");
  const proposed = ui.$("assistant-after").textContent;
  assert.equal(ui.current(), ui.initial);
  ui.$("assistant-apply").click(); const revision = ui.w.fixtureState.project.revision;
  assert.equal(ui.current(), proposed); assert.equal(ui.$("assistant-undo").hidden, false);
  assert.equal(ui.$("assistant-proposal").hidden, true);
  ui.$("assistant-apply").click(); assert.equal(ui.w.fixtureState.project.revision, revision);
  ui.$("assistant-undo").click(); assert.equal(ui.current(), ui.initial);
  assert.equal(ui.w.fixtureState.project.files["other.py"], "# untouched\r\n");
  assert.equal(ui.$("draft-state").textContent, "Saved");
  assert.equal(ui.store.getVersion(ui.project.id, 1).files["strategy.py"], ui.initial);
  assert.equal(ui.calls.some((call) => call.method !== "GET"), false);
});

test("current revision and exact-base checks reject stale Apply; Undo cannot overwrite intervening edits", async (t) => {
  const ui = await boot(t, "# original\r\n");
  ui.ask("create blank");
  ui.input("editor", "# newer\n");
  assert.equal(ui.$("assistant-before").textContent, ui.initial, "Review remains tied to the requested source");
  assert.equal(ui.$("assistant-before-title").textContent, "Before proposal", "A stale base is never labeled current source");
  assert.match(ui.$("assistant-diff-legend").textContent, /line before proposal/);
  ui.$("assistant-apply").click(); assert.equal(ui.current(), "# newer\r\n");
  assert.match(ui.$("assistant-messages").textContent, /draft changed after this proposal/);
  ui.ask("create blank");
  ui.w.fixtureState.project.files["strategy.py"] += "\r";
  ui.$("assistant-apply").click(); assert.equal(ui.current(), "# newer\r\n\r");
  assert.match(ui.$("assistant-messages").textContent, /editor changed after this proposal/);
  ui.ask("create blank"); ui.$("assistant-apply").click(); ui.input("editor", "# do not overwrite\n");
  const latest = ui.current(); ui.$("assistant-undo").click(); assert.equal(ui.current(), latest);
  assert.match(ui.$("assistant-messages").textContent, /Undo would overwrite your work/);
});

test("Dismiss, another request and file switching clear pending review without applying it", async (t) => {
  const ui = await boot(t, "# original\n"), storage = ui.storage();
  ui.ask("create blank"); ui.$("assistant-dismiss").click(); ui.$("assistant-apply").click();
  assert.equal(ui.$("assistant-proposal").hidden, true); assert.equal(ui.current(), ui.initial);
  ui.ask("create blank"); ui.ask("explain sdk"); ui.$("assistant-apply").click();
  assert.equal(ui.$("assistant-proposal").hidden, true); assert.equal(ui.current(), ui.initial);
  ui.ask("create blank"); ui.input("editor-file", "other.py", "change"); ui.$("assistant-apply").click();
  assert.equal(ui.$("assistant-proposal").hidden, true); assert.equal(ui.current(), ui.initial);
  assert.equal(ui.w.fixtureState.project.files["other.py"], "# untouched\r\n");
  assert.deepEqual(ui.storage(), storage);
});

test("oversized and dense diffs open complete before/after with truthful replacement-block counts", async (t) => {
  const ui = await boot(t, "#x\n".repeat(30000));
  ui.ask("create blank");
  assert.equal(ui.$("assistant-diff-review").hidden, true);
  assert.equal(ui.$("assistant-full-source").open, true);
  assert.equal(ui.$("assistant-diff-lines").children.length, 0);
  assert.equal(ui.$("assistant-before").textContent.length, 90000);
  assert.equal(ui.$("assistant-before").textContent, ui.initial);
  assert.equal(ui.$("assistant-after").textContent, ui.w.VeyraStudioAssistant.templates.blank);
  assert.match(ui.$("assistant-diff-summary").textContent, /Replacement block/);
  assert.match(ui.$("assistant-diff-note").textContent, /nothing is truncated/);
  assert.match(ui.$("assistant-diff-note").textContent, /not a minimal line diff/);
  assert.equal(ui.current(), ui.initial);
  ui.$("assistant-apply").click(); ui.$("assistant-undo").click(); assert.equal(ui.current(), ui.initial);
  ui.w.fixtureReview("a\n".repeat(210), "b\n".repeat(210));
  assert.match(ui.$("assistant-diff-summary").textContent, /\+210 added \/ −210 removed/);
  assert.doesNotMatch(ui.$("assistant-diff-summary").textContent, /Replacement block/);
  assert.equal(ui.$("assistant-before").textContent, "a\n".repeat(210));
});

test("synthetic whitespace and newline changes are explicit while source-looking markup never becomes elements", async (t) => {
  const ui = await boot(t, "# fixture\n");
  ui.w.fixtureReview("a\r\nb\r\tc \n", "a\nb\n  c");
  assert.match(ui.$("assistant-diff-summary").textContent, /whitespace-only changes/);
  for (const ending of ["CRLF", "CR", "LF", "no final newline"]) assert.ok(ui.$("assistant-diff-lines").textContent.includes(ending));
  assert.match(ui.$("assistant-diff-lines").textContent, /⇥/);
  assert.match(ui.$("assistant-before-info").textContent, /1 LF, 1 CRLF, 1 CR/);
  assert.match(ui.$("assistant-after-info").textContent, /no final newline/);
  const before = '<script>window.injection = true</script>\r\n', after = '<img src=x onerror="window.injection = true">😀\r';
  ui.w.fixtureReview(before, after);
  assert.equal(ui.$("assistant-before").textContent, before); assert.equal(ui.$("assistant-after").textContent, after);
  assert.equal(ui.$("assistant-proposal").querySelectorAll("script, img").length, 0);
  assert.equal(ui.w.injection, undefined);
  assert.ok(ui.$("assistant-diff-lines").querySelector(".proposal-add code").textContent.includes("<img"));
});
