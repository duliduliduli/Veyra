// Pure JS tests only. Fixtures are synthetic, not recorded user runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import chart from "../../apps/web/chart-research.js";

const { readSavedRunPage, groupSavedRuns, checkSavedRun, SAVED_RUN_LIMITS } = chart;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n, changes = {}) => ({ id: id(n), project_id: id(100), project_name: "Example strategy",
  project_version_id: id(200), version_no: 1, report_id: id(n + 1000), state: "settled", outcome: "completed",
  dataset_id: "synth-btcusd-1d-v1", start: "2024-01-01", end: "2024-02-01", created_at: `2026-01-${String(n).padStart(2, "0")}T12:00:00.123456Z`, ...changes });
const page = (jobs, next_cursor = null) => ({ jobs, next_cursor, has_more: next_cursor !== null });

test("saved runs append multiple explicit pages and group strategy/date newest first", () => {
  const first = readSavedRunPage(page([row(3), row(2, { project_id: id(101), project_name: "Other" })], "cursor-a"));
  const second = readSavedRunPage(page([row(1), row(4, { created_at: row(3).created_at })]), first.rows, [first.cursor]);
  assert.deepEqual(second.rows.map(j => j.id), [id(4), id(3), id(2), id(1)]);
  const groups = groupSavedRuns(second.rows);
  assert.deepEqual(groups.map(g => g.name), ["Example strategy", "Other"]);
  assert.deepEqual(groups[0].dates.map(d => d.date), ["2026-01-03", "2026-01-01"]);
  assert.deepEqual(groups[0].dates[0].runs.map(j => j.id), [id(4), id(3)]);
  assert.ok(second.rows.every(Object.isFrozen));
  assert.equal(second.cursor, null);
});

test("malformed, duplicate, unbounded and repeating pages are rejected atomically", () => {
  const first = readSavedRunPage(page([row(1)], "cursor-a"));
  const before = JSON.stringify(first);
  for (const malformed of [null, {}, { jobs: [], next_cursor: null }, page([row(1), row(1)]), page([row(1)]),
    page([], "empty-page"), page([row(2)], "cursor-a"), page([row(2)], "bad cursor"), page([row(2)], "x".repeat(513)),
    { jobs: [], has_more: false, next_cursor: "contradiction" }, page(Array(26).fill(row(2))),
    page([row(2, { id: "../../foreign" })]), page([row(2, { report_id: undefined })]),
    page([row(2, { created_at: "2026-02-30T00:00:00Z" })]), page([row(2, { created_at: "2026-01-01" })]),
    page([row(2, { version_no: 0 })]), page([row(2, { project_name: "x".repeat(201) })]),
    page([row(2, { dataset_id: [] })]), page([row(2, { outcome: "profitable" })]),
    page([row(2, { start: "2026-02-30" })])]) {
    assert.throws(() => readSavedRunPage(malformed, first.rows, [first.cursor]));
    assert.equal(JSON.stringify(first), before, "A bad page never mutates loaded rows or cursor");
  }
  assert.throws(() => readSavedRunPage(page([row(2)]), first.rows, Array(SAVED_RUN_LIMITS.pages).fill("cursor")), /limit/);
  assert.throws(() => readSavedRunPage(page([row(2)]), Array(500).fill(first.rows[0]), []), /limit/);
});

test("missing reports and unsupported or legacy range records remain visible but unavailable", () => {
  const rows = readSavedRunPage(page([row(1, { report_id: null }), row(2, { state: "running" }),
    row(3, { dataset_id: "external-live-market" }), row(4, { start: null, end: null })])).rows;
  assert.deepEqual(new Set(rows.map(j => j.unavailable)), new Set(["No saved report", "Report not settled", "Dataset unavailable on chart", "Recorded date range unavailable"]));
  assert.deepEqual(readSavedRunPage(page([])), { rows: [], cursor: null });
});

test("selection pins run, organization, report, version, config inputs and recorded date", () => {
  const saved = readSavedRunPage(page([row(1)])).rows[0];
  const job = { ...saved, org_id: id(300), config: { project_version_id: saved.project_version_id,
    dataset_id: saved.dataset_id, input_hash: `sha256:${"a".repeat(64)}`, start: saved.start, end: saved.end } };
  checkSavedRun(job, saved, id(300));
  for (const key of ["id", "org_id", "report_id", "project_version_id", "state", "outcome", "created_at"]) {
    assert.throws(() => checkSavedRun({ ...job, [key]: "wrong" }, saved, id(300)), /identity/);
  }
  for (const key of ["project_version_id", "dataset_id", "start", "end", "input_hash"]) {
    assert.throws(() => checkSavedRun({ ...job, config: { ...job.config, [key]: "wrong" } }, saved, id(300)));
  }
  assert.throws(() => checkSavedRun(job, { ...saved, unavailable: "No report" }, id(300)), /unavailable/);
});

test("newest-first order preserves PostgreSQL microseconds over opposite UUID ordering and timezone offsets", () => {
  const rows = readSavedRunPage(page([
    row(3, { created_at: "2026-01-03T12:00:00.123001Z" }),
    row(2, { created_at: "2026-01-03T13:00:00.123999+01:00" }),
    row(1, { created_at: "2026-01-03T12:00:00.124000Z" }),
  ])).rows;
  assert.deepEqual(rows.map(r => r.id), [id(1), id(2), id(3)]);
  assert.deepEqual(groupSavedRuns(rows.reverse())[0].dates[0].runs.map(r => r.id), [id(1), id(2), id(3)]);
  assert.equal(rows.find(r => r.id === id(2)).created_at, "2026-01-03T13:00:00.123999+01:00");
});
