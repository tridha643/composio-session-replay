/** A value that can be persisted without executable or prototype-bearing state. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The twelve SDK operations whose outcome must be represented in a complete run. */
export const ASSIGNED_OPERATIONS = [
  "session.toolkits",
  "session.tools",
  "session.search",
  "session.link",
  "session.files.createUploadURL",
  "session.files.list",
  "session.executeMeta",
  "session.files.createDownloadURL",
  "session.execute",
  "session.proxyExecute",
  "session.files.delete",
  "session.delete",
] as const;

/** A required Composio SDK operation recorded by the workflow. */
export type AssignedOperation = (typeof ASSIGNED_OPERATIONS)[number];
/** A supporting operation that must be replayed even though it is outside assigned SDK coverage. */
export type SupportingOperation = "session.create" | "session.retrieve" | "signed-url.put" | "signed-url.get";
/** Every operation that may appear in a persisted workflow event. */
export type WorkflowOperation = AssignedOperation | SupportingOperation;
/** The execution boundary responsible for a recorded event. */
export type EventKind = "sdk" | "transfer" | "support";
/** The final or recoverable lifecycle state of a run. */
export type RunStatus = "running" | "verified" | "failed" | "unknown" | "unsupported" | "cleanup_failed";
/** The layer that produced an execution error. */
export type RunErrorCategory = "sdk" | "tool" | "provider" | "transfer" | "validation" | "unsupported" | "unknown";

/** A sanitized error safe to write to local JSON and return through the HTTP API. */
export interface RunError {
  message: string;
  category: RunErrorCategory;
  retryable?: boolean;
}

interface WorkflowEventBase {
  id: string;
  kind: EventKind;
  operation: WorkflowOperation;
  startedAt: string;
  input: unknown;
}

/** A durable marker written before an operation is dispatched. */
export interface StartedWorkflowEvent extends WorkflowEventBase {
  status: "started";
  durationMs: null;
  output: null;
}

/** A completed operation whose output passed its operation-level checks. */
export interface SuccessfulWorkflowEvent extends WorkflowEventBase {
  status: "success";
  durationMs: number;
  output: unknown;
}

/** A completed operation known to have failed without an ambiguous write outcome. */
export interface FailedWorkflowEvent extends WorkflowEventBase {
  status: "error";
  durationMs: number;
  output: unknown;
  error: RunError;
}

/** An interrupted or timed-out operation whose external side effect is not known. */
export interface UnknownWorkflowEvent extends WorkflowEventBase {
  status: "unknown";
  durationMs: number | null;
  output: unknown;
  error: RunError;
}

/** An operation the bounded replay runner cannot reproduce safely. */
export interface UnsupportedWorkflowEvent extends WorkflowEventBase {
  status: "unsupported";
  durationMs: number | null;
  output: unknown;
  error: RunError;
}

/** An append-only, sanitized observation of one semantic workflow operation. */
export type WorkflowEvent = StartedWorkflowEvent | SuccessfulWorkflowEvent | FailedWorkflowEvent | UnknownWorkflowEvent | UnsupportedWorkflowEvent;

/** An exact category aggregate produced by the reviewed CSV report. */
export interface CategorySummary {
  category: string;
  rowCount: number;
  total: string;
}

/** Independently verifiable properties of the generated report. */
export interface ReportSummary {
  categories: CategorySummary[];
  grandTotal: string;
  inputRows: number;
  sha256: string;
}

/** User-controlled values required to start a fresh workflow run. */
export interface RunInput {
  csvName: string;
  csvContent: string;
  folderId: string;
  userId: string;
}

/** A compatibility view of an artifact shown by the current HTTP API. */
export interface RunArtifact {
  name: string;
  kind: "input" | "report" | "published";
  value: string;
}

/** A file descriptor whose logical identity survives regeneration of signed URLs. */
export interface ArtifactRef {
  artifactId: string;
  mountId: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/** A locally persisted run; CSV bytes and temporary signed URLs are deliberately absent. */
export interface RunRecord {
  runId: string;
  parentRunId: string | null;
  rootRunId: string;
  composioSessionId: string | null;
  createdAt: string;
  finishedAt: string | null;
  status: RunStatus;
  mode: "fake" | "live";
  input: Omit<RunInput, "csvContent"> & { contentBytes: number };
  summary: ReportSummary | null;
  artifacts: RunArtifact[];
  events: WorkflowEvent[];
  error: RunError | null;
}

/** Exact filters supported by JSON run persistence and the sessions list endpoint. */
export interface RunFilters {
  query?: string;
  status?: RunStatus;
  mode?: RunRecord["mode"];
  sessionId?: string;
  rootRunId?: string;
  parentRunId?: string | null;
}

/** The validated output returned by a concrete workflow driver. */
export interface DriverResult {
  composioSessionId: string;
  events: WorkflowEvent[];
  summary: ReportSummary;
  artifacts: RunArtifact[];
}

/** The execution seam used by both initial runs and fresh-session replay. */
export interface WorkflowDriver {
  readonly mode: RunRecord["mode"];
  execute(input: RunInput): Promise<DriverResult>;
}

/** A binding reads only literals, declared inputs, earlier outputs, or current-run state. */
export type Binding =
  | { source: "literal"; value: JsonValue }
  | { source: "input"; name: string }
  | { source: "step-output"; stepId: string; path: string[] }
  | { source: "current-artifact"; artifactId: string; field: keyof ArtifactRef }
  | { source: "run-context"; field: "runId" | "rootRunId" | "sessionId" };

/** The bounded families the V1 replay runner can reproduce. */
export type WorkflowStepFamily = "file-upload" | "file-download" | "native-execute" | "meta-execute" | "proxy-execute" | "assertion" | "cleanup";

/** One ordered operation with explicit argument bindings and declared artifact outputs. */
export interface WorkflowStep {
  id: string;
  family: WorkflowStepFamily;
  operation: WorkflowOperation | "assert";
  bindings: Record<string, Binding>;
  producesArtifacts?: string[];
}

/** An app-authored, versioned workflow consumed by replay and export. */
export interface WorkflowDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  inputSlots: string[];
  steps: WorkflowStep[];
}

/** Current-run values made available to deterministic binding resolution. */
export interface RunContext {
  runId: string;
  rootRunId: string;
  sessionId: string;
  inputs: Record<string, JsonValue>;
  stepOutputs: Record<string, JsonValue>;
  artifacts: Record<string, ArtifactRef>;
}

/** A per-category delta with exact decimal totals. */
export interface CategoryComparison {
  category: string;
  leftTotal: string | null;
  rightTotal: string | null;
  totalDelta: string;
  rowCountDelta: number;
}

/** A deterministic comparison between two verified report runs. */
export interface RunComparison {
  leftRunId: string;
  rightRunId: string;
  totalDelta: string;
  inputRowDelta: number;
  reportChanged: boolean;
  addedCategories: string[];
  removedCategories: string[];
  changedCategories: CategoryComparison[];
}

/** A standalone text project ready to serialize as JSON or package into an archive. */
export interface ExportBundle {
  filename: string;
  manifest: {
    version: 1;
    sourceRunId: string;
    workflow: string;
    inputSlots: string[];
    bindings: Record<string, string>;
  };
  files: Record<string, string>;
}

const RUN_STATUSES = new Set<RunStatus>(["running", "verified", "failed", "unknown", "unsupported", "cleanup_failed"]);
const RUN_MODES = new Set<RunRecord["mode"]>(["fake", "live"]);
const EVENT_KINDS = new Set<EventKind>(["sdk", "transfer", "support"]);
const EVENT_STATUSES = new Set(["started", "success", "error", "unknown", "unsupported"]);
const WORKFLOW_OPERATIONS = new Set<string>([...ASSIGNED_OPERATIONS, "session.create", "session.retrieve", "signed-url.put", "signed-url.get"]);
const DECIMAL_VALUE = /^-?\d+\.\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

function isRunError(value: unknown): value is RunError {
  if (!isRecord(value) || !hasString(value, "message") || typeof value.category !== "string") return false;
  return ["sdk", "tool", "provider", "transfer", "validation", "unsupported", "unknown"].includes(value.category);
}

function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  if (!isRecord(value) || !hasString(value, "id") || !hasString(value, "startedAt")) return false;
  if (!EVENT_KINDS.has(value.kind as EventKind) || !WORKFLOW_OPERATIONS.has(String(value.operation)) || !EVENT_STATUSES.has(String(value.status))) return false;
  if (!Object.hasOwn(value, "input") || !Object.hasOwn(value, "output")) return false;
  if (value.status === "started") return value.durationMs === null && value.output === null;
  if (value.durationMs !== null && (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0)) return false;
  if (value.status === "success") return typeof value.durationMs === "number";
  return isRunError(value.error);
}

function isReportSummary(value: unknown): value is ReportSummary {
  if (!isRecord(value) || !Array.isArray(value.categories) || !DECIMAL_VALUE.test(String(value.grandTotal))) return false;
  if (!Number.isSafeInteger(value.inputRows) || Number(value.inputRows) < 0 || !/^[a-f\d]{64}$/i.test(String(value.sha256))) return false;
  const categories = new Set<string>();
  for (const category of value.categories) {
    if (!isRecord(category) || !hasString(category, "category")) return false;
    const categoryName = category.category as string;
    if (!categoryName || categories.has(categoryName)) return false;
    if (!Number.isSafeInteger(category.rowCount) || Number(category.rowCount) < 0 || !DECIMAL_VALUE.test(String(category.total))) return false;
    categories.add(categoryName);
  }
  return true;
}

function isRunArtifact(value: unknown): value is RunArtifact {
  return isRecord(value) && hasString(value, "name") && hasString(value, "value") && ["input", "report", "published"].includes(String(value.kind));
}

/** Parses persisted JSON into a run record, rejecting corrupt or structurally stale files. */
export function parseRunRecord(value: unknown): RunRecord {
  if (!isRecord(value)) throw new Error("Invalid run record: expected an object");
  if (!["runId", "rootRunId", "createdAt"].every((key) => hasString(value, key))) throw new Error("Invalid run record: missing run identity or timestamp");
  if (value.parentRunId !== null && typeof value.parentRunId !== "string") throw new Error("Invalid run record: parentRunId must be a string or null");
  if (value.composioSessionId !== null && typeof value.composioSessionId !== "string") throw new Error("Invalid run record: composioSessionId must be a string or null");
  if (value.finishedAt !== null && typeof value.finishedAt !== "string") throw new Error("Invalid run record: finishedAt must be a string or null");
  if (!RUN_STATUSES.has(value.status as RunStatus)) throw new Error("Invalid run record: unknown status");
  if (!RUN_MODES.has(value.mode as RunRecord["mode"])) throw new Error("Invalid run record: unknown driver mode");
  if (!isRecord(value.input) || !hasString(value.input, "csvName") || !hasString(value.input, "folderId") || !hasString(value.input, "userId") || !Number.isSafeInteger(value.input.contentBytes) || Number(value.input.contentBytes) < 0) {
    throw new Error("Invalid run record: malformed input metadata");
  }
  if (!Array.isArray(value.events) || !value.events.every(isWorkflowEvent)) throw new Error("Invalid run record: malformed workflow events");
  if (!Array.isArray(value.artifacts) || !value.artifacts.every(isRunArtifact)) throw new Error("Invalid run record: malformed artifacts");
  if (value.summary !== null && !isReportSummary(value.summary)) throw new Error("Invalid run record: malformed report summary");
  if (value.error !== null && !isRunError(value.error)) throw new Error("Invalid run record: malformed error");
  if (value.status === "verified" && value.summary === null) throw new Error("Invalid run record: verified run requires a summary");
  return value as unknown as RunRecord;
}
