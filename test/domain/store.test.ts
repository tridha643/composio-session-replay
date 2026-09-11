import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { JsonRunStore } from "../../src/domain/store.js";
import { testRun } from "./test-run.js";

test("JSON run store sanitizes records and filters exact run/session lineage", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "run-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonRunStore(directory);
  const original = testRun({
    events: [{ id: "event-secret", kind: "sdk", operation: "session.execute", status: "success", startedAt: "2026-09-11T12:00:00.000Z", durationMs: 1, input: { api_key: "do-not-store", source_url: "https://example.test/report?token=do-not-store" }, output: {} }],
  });
  const replay = testRun({ runId: "run-two", parentRunId: "run-one", rootRunId: "run-one", composioSessionId: "session-two", createdAt: "2026-09-11T13:00:00.000Z", input: { ...original.input, csvName: "october.csv" } });

  await Promise.all([store.save(original), store.save(replay)]);
  const serialized = await readFile(path.join(directory, "run-one.json"), "utf8");
  assert.equal(serialized.includes("do-not-store"), false);
  assert.deepEqual((await store.list({ rootRunId: "run-one" })).map((run) => run.runId), ["run-two", "run-one"]);
  assert.deepEqual((await store.list({ parentRunId: null })).map((run) => run.runId), ["run-one"]);
  assert.deepEqual((await store.listSessionRuns("session-two")).map((run) => run.runId), ["run-two"]);
  assert.deepEqual((await store.list({ query: "OCTOBER" })).map((run) => run.runId), ["run-two"]);
});

test("JSON run store rejects path traversal and corrupt persisted data", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "run-store-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonRunStore(directory);
  await assert.rejects(store.get("../outside"), /Invalid run ID/);
  const malformed = testRun({ events: [] });
  await writeFile(path.join(directory, "invalid.json"), JSON.stringify({ ...malformed, events: [{ operation: "invented.operation" }] }), "utf8");
  await assert.rejects(store.get("invalid"), /malformed workflow events/);
  await rm(path.join(directory, "invalid.json"));
  await writeFile(path.join(directory, "broken.json"), "{not json", "utf8");
  await assert.rejects(store.list(), /Corrupt run JSON in broken.json/);
});
