import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createReplayServer } from "../../src/server.js";

let origin = "";
let closeServer: (() => Promise<void>) | undefined;
let dataDirectory = "";

before(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "composio-replay-e2e-"));
  const running = await createReplayServer({ port: 0, driver: "fake", dataDirectory });
  origin = running.origin;
  closeServer = running.close;
});

after(async () => {
  await closeServer?.();
  await rm(dataDirectory, { recursive: true, force: true });
});

async function jsonRequest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

test("records, filters, replays, compares, and exports a complete workflow", async () => {
  const septemberCsv = await readFile("fixtures/sales-september.csv", "utf8");
  const octoberCsv = await readFile("fixtures/sales-october.csv", "utf8");

  const healthResponse = await jsonRequest("/api/health");
  assert.deepEqual(await healthResponse.json(), { ok: true, mode: "fake" });

  const logoResponse = await jsonRequest("/assets/brand/Logo-White.svg");
  assert.equal(logoResponse.status, 200);
  assert.equal(logoResponse.headers.get("content-type"), "image/svg+xml");

  const firstResponse = await jsonRequest("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      csvName: "sales-september.csv",
      csvContent: septemberCsv,
      folderId: "drive-folder-test",
      userId: "hackathon-test-user",
    }),
  });
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json() as any;
  assert.equal(first.status, "verified");
  assert.equal(first.summary.grandTotal, "1680.00");
  assert.equal(first.parentRunId, null);
  assert.equal(new Set(first.events.filter((event: any) => event.kind === "sdk").map((event: any) => event.operation)).size, 12);
  assert.ok(first.events.some((event: any) => event.operation === "signed-url.put"));
  assert.ok(first.events.some((event: any) => event.operation === "signed-url.get"));
  assert.equal(JSON.stringify(first).includes(septemberCsv), false);
  assert.equal(JSON.stringify(first).includes("fake-secret"), false);

  const sessionsResponse = await jsonRequest("/api/sessions?query=september&status=verified");
  assert.equal(sessionsResponse.status, 200);
  const sessions = await sessionsResponse.json() as any[];
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].runId, first.runId);

  const detailResponse = await jsonRequest(`/api/sessions/${first.runId}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json() as any).composioSessionId, first.composioSessionId);

  const replayResponse = await jsonRequest(`/api/runs/${first.runId}/replay`, {
    method: "POST",
    body: JSON.stringify({ csvName: "sales-october.csv", csvContent: octoberCsv }),
  });
  assert.equal(replayResponse.status, 201);
  const replay = await replayResponse.json() as any;
  assert.equal(replay.status, "verified");
  assert.equal(replay.summary.grandTotal, "2240.00");
  assert.equal(replay.parentRunId, first.runId);
  assert.notEqual(replay.composioSessionId, first.composioSessionId);

  const comparisonResponse = await jsonRequest(`/api/runs/${first.runId}/compare/${replay.runId}`);
  assert.equal(comparisonResponse.status, 200);
  const comparison = await comparisonResponse.json() as any;
  assert.equal(comparison.totalDelta, "560.00");
  assert.deepEqual(comparison.addedCategories, ["West"]);

  const exportResponse = await jsonRequest(`/api/runs/${replay.runId}/export`, { method: "POST" });
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json() as any;
  assert.ok(exported.files["src/workflow.ts"]);
  assert.ok(exported.files["src/runner.ts"]);
  assert.ok(exported.files["README.md"]);
  const serialized = JSON.stringify(exported);
  assert.equal(serialized.includes(first.composioSessionId), false);
  assert.equal(/https?:[^\s"']+[?&](?:token|signature|x-amz-credential)=/i.test(serialized), false);
});
