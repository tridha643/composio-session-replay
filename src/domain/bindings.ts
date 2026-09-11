import type { Binding, JsonValue, RunContext, WorkflowDefinition, WorkflowStep } from "./types.js";

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const FAMILY_OPERATIONS: Record<WorkflowStep["family"], ReadonlySet<WorkflowStep["operation"]>> = {
  "file-upload": new Set(["session.files.createUploadURL", "signed-url.put"]),
  "file-download": new Set(["session.files.list", "session.files.createDownloadURL", "signed-url.get"]),
  "native-execute": new Set(["session.execute"]),
  "meta-execute": new Set(["session.executeMeta"]),
  "proxy-execute": new Set(["session.proxyExecute"]),
  assertion: new Set(["assert"]),
  cleanup: new Set(["session.files.delete", "session.delete", "session.retrieve"]),
};

function copyJsonValue(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function requireOwnValue(record: Record<string, JsonValue>, key: string, description: string): JsonValue {
  if (!Object.hasOwn(record, key)) throw new Error(`Workflow binding missing ${description}: ${key}`);
  return record[key]!;
}

function readOutputPath(output: JsonValue, path: string[]): JsonValue {
  let current = output;
  for (const segment of path) {
    if (BLOCKED_PATH_SEGMENTS.has(segment)) throw new Error(`Workflow binding rejects unsafe output path segment: ${segment}`);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= current.length) throw new Error(`Workflow binding output path not found: ${path.join(".")}`);
      current = current[Number(segment)]!;
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, segment)) {
      current = current[segment]!;
    } else {
      throw new Error(`Workflow binding output path not found: ${path.join(".")}`);
    }
  }
  return current;
}

/** Resolves one binding exclusively from the supplied current-run context. */
export function resolveWorkflowBinding(binding: Binding, context: RunContext): JsonValue {
  switch (binding.source) {
    case "literal":
      return copyJsonValue(binding.value);
    case "input":
      return copyJsonValue(requireOwnValue(context.inputs, binding.name, "input"));
    case "step-output":
      return copyJsonValue(readOutputPath(requireOwnValue(context.stepOutputs, binding.stepId, "step output"), binding.path));
    case "current-artifact": {
      const artifact = context.artifacts[binding.artifactId];
      if (!artifact) throw new Error(`Workflow binding missing current artifact: ${binding.artifactId}`);
      return artifact[binding.field];
    }
    case "run-context":
      return binding.field === "sessionId" ? context.sessionId : context[binding.field];
  }
}

function validateBinding(binding: Binding, stepIndex: number, stepIndexes: Map<string, number>, inputs: Set<string>, artifacts: Set<string>): void {
  if (binding.source === "input" && !inputs.has(binding.name)) throw new Error(`Workflow definition binding references undeclared input: ${binding.name}`);
  if (binding.source === "step-output") {
    const referencedIndex = stepIndexes.get(binding.stepId);
    if (referencedIndex === undefined) throw new Error(`Workflow definition binding references missing step: ${binding.stepId}`);
    if (referencedIndex >= stepIndex) throw new Error(`Workflow definition binding has forward reference: ${binding.stepId}`);
    if (binding.path.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) throw new Error(`Workflow definition binding has unsafe output path: ${binding.path.join(".")}`);
  }
  if (binding.source === "current-artifact" && !artifacts.has(binding.artifactId)) throw new Error(`Workflow definition binding references unavailable artifact: ${binding.artifactId}`);
}

function validateJsonLiteral(value: JsonValue, location: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Workflow definition literal is not finite: ${location}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonLiteral(item, `${location}.${index}`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED_PATH_SEGMENTS.has(key)) throw new Error(`Workflow definition literal has unsafe key: ${key}`);
    validateJsonLiteral(child, `${location}.${key}`);
  }
}

/** Validates unique IDs and rejects missing or forward references before any workflow write. */
export function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  if (definition.schemaVersion !== 1) throw new Error(`Unsupported workflow schema version: ${String(definition.schemaVersion)}`);
  if (!SAFE_IDENTIFIER.test(definition.id)) throw new Error(`Invalid workflow definition ID: ${definition.id}`);
  const inputs = new Set<string>();
  for (const input of definition.inputSlots) {
    if (!SAFE_IDENTIFIER.test(input)) throw new Error(`Invalid workflow input slot: ${input}`);
    if (inputs.has(input)) throw new Error(`Duplicate workflow input slot: ${input}`);
    inputs.add(input);
  }
  const stepIndexes = new Map<string, number>();
  definition.steps.forEach((step, index) => {
    if (!SAFE_IDENTIFIER.test(step.id)) throw new Error(`Invalid workflow step ID: ${step.id}`);
    if (stepIndexes.has(step.id)) throw new Error(`Duplicate workflow step ID: ${step.id}`);
    stepIndexes.set(step.id, index);
  });
  const artifacts = new Set<string>();
  definition.steps.forEach((step, index) => {
    if (!FAMILY_OPERATIONS[step.family]?.has(step.operation)) throw new Error(`Workflow step ${step.id} uses ${step.operation} with incompatible family ${step.family}`);
    for (const name of Object.keys(step.bindings)) if (!SAFE_IDENTIFIER.test(name)) throw new Error(`Invalid workflow binding name: ${name}`);
    Object.values(step.bindings).forEach((binding) => validateBinding(binding, index, stepIndexes, inputs, artifacts));
    Object.entries(step.bindings).forEach(([name, binding]) => {
      if (binding.source === "literal") validateJsonLiteral(binding.value, `${step.id}.${name}`);
    });
    for (const artifactId of step.producesArtifacts ?? []) {
      if (!SAFE_IDENTIFIER.test(artifactId)) throw new Error(`Invalid workflow artifact ID: ${artifactId}`);
      if (artifacts.has(artifactId)) throw new Error(`Duplicate workflow artifact ID: ${artifactId}`);
      artifacts.add(artifactId);
    }
  });
}

/** Resolves all arguments for one validated step without inference from string equality. */
export function resolveWorkflowStepBindings(definition: WorkflowDefinition, stepId: string, context: RunContext): Record<string, JsonValue> {
  validateWorkflowDefinition(definition);
  const stepIndex = definition.steps.findIndex((step) => step.id === stepId);
  if (stepIndex < 0) throw new Error(`Workflow step not found: ${stepId}`);
  const completedStepIds = new Set(definition.steps.slice(0, stepIndex).map((step) => step.id));
  const step: WorkflowStep = definition.steps[stepIndex]!;
  const resolved: Record<string, JsonValue> = {};
  for (const [name, binding] of Object.entries(step.bindings)) {
    if (binding.source === "step-output" && !completedStepIds.has(binding.stepId)) throw new Error(`Workflow binding is not from a prior step: ${binding.stepId}`);
    resolved[name] = resolveWorkflowBinding(binding, context);
  }
  return resolved;
}
