import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWorkflowStepBindings, validateWorkflowDefinition } from "../../src/domain/bindings.js";
import type { RunContext, WorkflowDefinition } from "../../src/domain/types.js";

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "csv-report",
  name: "CSV report",
  inputSlots: ["folderId"],
  steps: [
    { id: "stage", family: "file-upload", operation: "session.files.createUploadURL", bindings: { folder: { source: "input", name: "folderId" } }, producesArtifacts: ["report"] },
    { id: "publish", family: "native-execute", operation: "session.execute", bindings: {
      fileId: { source: "step-output", stepId: "stage", path: ["data", "fileId"] },
      reportPath: { source: "current-artifact", artifactId: "report", field: "relativePath" },
      sessionId: { source: "run-context", field: "sessionId" },
      mimeType: { source: "literal", value: "text/csv" },
    } },
  ],
};

const context: RunContext = {
  runId: "run-new",
  rootRunId: "run-root",
  sessionId: "session-new",
  inputs: { folderId: "folder-new" },
  stepOutputs: { stage: { data: { fileId: "file-new" } } },
  artifacts: { report: { artifactId: "report", mountId: "files", relativePath: "runs/run-new/report.csv", mimeType: "text/csv", sizeBytes: 10, sha256: "a".repeat(64) } },
};

test("workflow bindings resolve only declared current-run values", () => {
  validateWorkflowDefinition(definition);
  assert.deepEqual(resolveWorkflowStepBindings(definition, "publish", context), {
    fileId: "file-new",
    reportPath: "runs/run-new/report.csv",
    sessionId: "session-new",
    mimeType: "text/csv",
  });
});

test("workflow definition rejects forward references before execution", () => {
  const invalid: WorkflowDefinition = {
    ...definition,
    steps: [
      { id: "publish", family: "native-execute", operation: "session.execute", bindings: { value: { source: "step-output", stepId: "later", path: [] } } },
      { id: "later", family: "assertion", operation: "assert", bindings: {} },
    ],
  };
  assert.throws(() => validateWorkflowDefinition(invalid), /forward reference: later/);
  assert.throws(() => validateWorkflowDefinition({
    ...definition,
    steps: [{ id: "mismatch", family: "assertion", operation: "session.execute", bindings: {} }],
  }), /incompatible family assertion/);
});

test("workflow binding rejects prototype traversal and absent values", () => {
  const unsafe: WorkflowDefinition = {
    ...definition,
    steps: [definition.steps[0]!, { ...definition.steps[1]!, bindings: { value: { source: "step-output", stepId: "stage", path: ["__proto__"] } } }],
  };
  assert.throws(() => validateWorkflowDefinition(unsafe), /unsafe output path/);
  assert.throws(() => resolveWorkflowStepBindings(definition, "publish", { ...context, stepOutputs: {} }), /missing step output: stage/);
});
