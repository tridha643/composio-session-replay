import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { FakeComposioDriver } from "../../src/composio/fake-driver.js";
import { assertExportBundleSafe, createExportBundle } from "../../src/domain/export.js";
import { ReplayService, WorkflowRunError } from "../../src/domain/service.js";
import { JsonRunStore } from "../../src/domain/store.js";
import type { WorkflowDriver } from "../../src/domain/types.js";
import { testRun } from "./test-run.js";

const execFileAsync = promisify(execFile);

test("replay creates fresh lineage and comparison uses exact category deltas", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "replay-service-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonRunStore(directory);
  const service = new ReplayService(store, new FakeComposioDriver());
  const first = await service.start({ csvName: "first.csv", csvContent: "category,amount\nEast,100.01\n", folderId: "folder", userId: "user" });
  const replay = await service.replay(first.runId, { csvName: "second.csv", csvContent: "category,amount\nEast,100.11\nWest,0.20\n" });
  const comparison = await service.compare(first.runId, replay.runId);

  assert.equal(replay.parentRunId, first.runId);
  assert.equal(replay.rootRunId, first.runId);
  assert.notEqual(replay.composioSessionId, first.composioSessionId);
  assert.equal(comparison.totalDelta, "0.30");
  assert.deepEqual(comparison.addedCategories, ["West"]);
  assert.deepEqual(comparison.changedCategories.map((category) => category.category), ["East", "West"]);

  const largeLeft = testRun({ runId: "large-left", rootRunId: "large-left", summary: { categories: [{ category: "East", rowCount: 1, total: "90071992547409.91" }], grandTotal: "90071992547409.91", inputRows: 1, sha256: "a".repeat(64) } });
  const largeRight = testRun({ runId: "large-right", rootRunId: "large-right", summary: { categories: [{ category: "East", rowCount: 1, total: "90071992547410.01" }], grandTotal: "90071992547410.01", inputRows: 1, sha256: "b".repeat(64) } });
  await store.save(largeLeft);
  await store.save(largeRight);
  assert.equal((await service.compare(largeLeft.runId, largeRight.runId)).totalDelta, "0.10");
});

test("service preserves unknown outcomes and validates inputs before dispatch", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "replay-service-error-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const driver: WorkflowDriver = {
    mode: "live",
    execute: async () => { calls += 1; throw new WorkflowRunError("provider write timed out", "provider", "unknown"); },
  };
  const service = new ReplayService(new JsonRunStore(directory), driver);
  await assert.rejects(service.start({ csvName: "../unsafe.csv", csvContent: "category,amount\nEast,1\n", folderId: "folder", userId: "user" }), /safe basename/);
  assert.equal(calls, 0);
  const run = await service.start({ csvName: "safe.csv", csvContent: "category,amount\nEast,1\n", folderId: "folder", userId: "user" });
  assert.equal(run.status, "unknown");
  assert.deepEqual(run.error, { message: "provider write timed out", category: "provider" });
});

test("service preserves a structurally classified SDK failure timeline", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "replay-service-sdk-error-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const driver: WorkflowDriver = {
    mode: "live",
    execute: async () => {
      throw Object.assign(new Error("upload timed out with token=driver-secret"), {
        category: "transfer",
        outcome: "unknown",
        events: [{
          id: "failed-transfer",
          kind: "transfer",
          operation: "signed-url.put",
          status: "unknown",
          startedAt: "2026-09-11T12:00:00.000Z",
          durationMs: 12,
          input: { url: "https://example.test/upload?token=driver-secret" },
          output: {},
          error: { message: "upload timed out", category: "transfer" },
        }],
      });
    },
  };
  const service = new ReplayService(new JsonRunStore(directory), driver);
  const run = await service.start({ csvName: "safe.csv", csvContent: "category,amount\nEast,1\n", folderId: "folder", userId: "user" });

  assert.equal(run.status, "unknown");
  assert.equal(run.error?.category, "transfer");
  assert.equal(run.events[0]?.operation, "signed-url.put");
  assert.equal(JSON.stringify(run).includes("driver-secret"), false);
});

test("service sanitizes successful driver events before returning them", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "replay-service-redaction-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const summary = testRun().summary!;
  const driver: WorkflowDriver = {
    mode: "live",
    execute: async () => ({
      composioSessionId: "fresh-session",
      summary,
      artifacts: [],
      events: [{ id: "secret-event", kind: "sdk", operation: "session.execute", status: "success", startedAt: new Date().toISOString(), durationMs: 1, input: { api_key: "driver-secret", source_url: "https://example.test/file?token=driver-secret" }, output: {} }],
    }),
  };
  const service = new ReplayService(new JsonRunStore(directory), driver);
  const run = await service.start({ csvName: "safe.csv", csvContent: "category,amount\nEast,1\n", folderId: "folder", userId: "user" });
  assert.equal(JSON.stringify(run).includes("driver-secret"), false);
});

test("standalone export is complete, session-independent, safety checked, and type-correct", async (context) => {
  const run = testRun();
  const bundle = createExportBundle(run);
  assert.ok(bundle.files["src/runner.ts"]?.includes("client.toolRouter.session.create"));
  assert.ok(bundle.files["src/runner.ts"]?.includes("client.toolRouter.session.link"));
  assert.equal(bundle.manifest.inputSlots.includes("connectedAccountId"), false);
  assert.ok(bundle.files["report.py"]?.includes("Decimal"));
  assert.equal((JSON.parse(bundle.files["package-lock.json"]!) as { name: string }).name, "composio-replay-export");
  assert.equal(JSON.stringify(bundle).includes(run.composioSessionId!), false);
  assert.doesNotThrow(() => assertExportBundleSafe(bundle));
  const unsafe = { ...bundle, files: { ...bundle.files, "README.md": "COMPOSIO_API_KEY=real-secret" } };
  assert.throws(() => assertExportBundleSafe(unsafe), /credential-bearing content/);
  assert.throws(() => createExportBundle(testRun({ status: "failed", summary: null })), /Only verified runs/);

  const projectDirectory = await mkdtemp(path.join(process.cwd(), "test/domain/.export-compile-"));
  context.after(() => rm(projectDirectory, { recursive: true, force: true }));
  await Promise.all(Object.entries(bundle.files).map(async ([filename, content]) => {
    const target = path.join(projectDirectory, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }));
  await execFileAsync(path.resolve("node_modules/.bin/tsc"), ["-p", path.join(projectDirectory, "tsconfig.json"), "--noEmit"]);
});
