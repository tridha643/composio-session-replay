import type { RunRecord } from "../../src/domain/types.js";

/** Builds a complete persisted run for focused domain tests. */
export function testRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const runId = overrides.runId ?? "run-one";
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    composioSessionId: "session-one",
    createdAt: "2026-09-11T12:00:00.000Z",
    finishedAt: "2026-09-11T12:00:01.000Z",
    status: "verified",
    mode: "fake",
    input: { csvName: "sales.csv", folderId: "folder-one", userId: "user-one", contentBytes: 42 },
    summary: {
      categories: [{ category: "East", rowCount: 2, total: "10.00" }],
      grandTotal: "10.00",
      inputRows: 2,
      sha256: "a".repeat(64),
    },
    artifacts: [{ name: "sales.csv", kind: "input", value: "runs/run-one/sales.csv" }],
    events: [{ id: "event-one", kind: "sdk", operation: "session.tools", status: "success", startedAt: "2026-09-11T12:00:00.000Z", durationMs: 1, input: {}, output: {} }],
    error: null,
    ...overrides,
  };
}
