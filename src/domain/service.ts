import { randomUUID } from "node:crypto";

import { createExportBundle } from "./export.js";
import { redact } from "./redact.js";
import { JsonRunStore } from "./store.js";
import { parseRunRecord } from "./types.js";
import type { CategoryComparison, ExportBundle, RunComparison, RunErrorCategory, RunFilters, RunInput, RunRecord, RunStatus, WorkflowDriver } from "./types.js";

const MAX_CSV_BYTES = 1024 * 1024;
const DECIMAL_AMOUNT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const RUN_STATUSES = new Set<RunStatus>(["running", "verified", "failed", "unknown", "unsupported", "cleanup_failed"]);
const RUN_ERROR_CATEGORIES = new Set<RunErrorCategory>(["validation", "sdk", "tool", "provider", "transfer", "unsupported", "unknown"]);
const TERMINAL_FAILURE_STATUSES = new Set<RunStatus>(["failed", "unknown", "unsupported", "cleanup_failed"]);

/** An execution failure carrying the outcome certainty needed to avoid unsafe write retries. */
export class WorkflowRunError extends Error {
  constructor(
    message: string,
    readonly category: RunErrorCategory,
    readonly outcome: "failed" | "unknown" | "unsupported" = "failed",
  ) {
    super(message);
    this.name = "WorkflowRunError";
  }
}

function decimalToMinorUnits(amount: string): bigint {
  const match = DECIMAL_AMOUNT.exec(amount);
  if (!match) throw new Error(`Invalid report decimal: ${amount}`);
  const magnitude = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -magnitude : magnitude;
}

function minorUnitsToDecimal(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

function validateRunInput(input: RunInput): RunInput {
  if (!input.csvName || !input.csvContent || !input.folderId.trim() || !input.userId.trim()) throw new Error("csvName, csvContent, folderId, and userId are required");
  if (!/\.csv$/i.test(input.csvName)) throw new Error("CSV input filename must end in .csv");
  if (input.csvName !== input.csvName.trim() || input.csvName.includes("/") || input.csvName.includes("\\") || /[\0-\x1f]/.test(input.csvName)) throw new Error("CSV input filename must be a safe basename");
  const contentBytes = Buffer.byteLength(input.csvContent);
  if (contentBytes > MAX_CSV_BYTES) throw new Error(`CSV input exceeds the ${MAX_CSV_BYTES} byte limit`);
  return { ...input, folderId: input.folderId.trim(), userId: input.userId.trim() };
}

function sanitizeErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitized = redact(rawMessage);
  return typeof sanitized === "string" ? sanitized : "Workflow execution failed";
}

interface RecordedDriverFailure {
  category: RunErrorCategory;
  outcome: "failed" | "unknown" | "unsupported" | "cleanup_failed";
  events?: unknown[];
}

/** Accepts adapter errors structurally so the domain layer does not depend on a concrete SDK driver. */
function recordedDriverFailure(error: unknown): RecordedDriverFailure | null {
  if (error instanceof WorkflowRunError) return { category: error.category, outcome: error.outcome };
  if (!error || typeof error !== "object") return null;
  const candidate = error as { category?: unknown; outcome?: unknown; events?: unknown };
  if (typeof candidate.category !== "string" || !RUN_ERROR_CATEGORIES.has(candidate.category as RunErrorCategory)) return null;
  if (typeof candidate.outcome !== "string" || !TERMINAL_FAILURE_STATUSES.has(candidate.outcome as RunStatus)) return null;
  return {
    category: candidate.category as RunErrorCategory,
    outcome: candidate.outcome as RecordedDriverFailure["outcome"],
    ...(Array.isArray(candidate.events) ? { events: candidate.events } : {}),
  };
}

function compareCategory(left: RunRecord["summary"], right: RunRecord["summary"], category: string): CategoryComparison {
  const leftCategory = left?.categories.find((item) => item.category === category);
  const rightCategory = right?.categories.find((item) => item.category === category);
  return {
    category,
    leftTotal: leftCategory?.total ?? null,
    rightTotal: rightCategory?.total ?? null,
    totalDelta: minorUnitsToDecimal(decimalToMinorUnits(rightCategory?.total ?? "0.00") - decimalToMinorUnits(leftCategory?.total ?? "0.00")),
    rowCountDelta: (rightCategory?.rowCount ?? 0) - (leftCategory?.rowCount ?? 0),
  };
}

/** Coordinates durable initial runs, fresh-session replay, comparison, and export. */
export class ReplayService {
  constructor(private readonly store: JsonRunStore, private readonly driver: WorkflowDriver) {}

  /** Starts a new run and persists both its pre-dispatch and terminal states. */
  async start(rawInput: RunInput, parentRunId: string | null = null): Promise<RunRecord> {
    const input = validateRunInput(rawInput);
    const runId = randomUUID();
    const parent = parentRunId ? await this.requireRun(parentRunId) : null;
    let run: RunRecord = {
      runId,
      parentRunId,
      rootRunId: parent?.rootRunId ?? runId,
      composioSessionId: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      mode: this.driver.mode,
      input: { csvName: input.csvName, folderId: input.folderId, userId: input.userId, contentBytes: Buffer.byteLength(input.csvContent) },
      summary: null,
      artifacts: [],
      events: [],
      error: null,
    };
    await this.store.save(run);
    try {
      const result = await this.driver.execute(input);
      if (!result.composioSessionId.trim()) throw new WorkflowRunError("Workflow driver returned no session ID", "sdk");
      const nonSuccessfulEvent = result.events.find((event) => event.status !== "success");
      if (nonSuccessfulEvent) throw new WorkflowRunError(`Workflow driver returned non-successful event: ${nonSuccessfulEvent.operation}`, nonSuccessfulEvent.status === "unsupported" ? "unsupported" : "unknown", nonSuccessfulEvent.status === "unsupported" ? "unsupported" : "unknown");
      run = parseRunRecord(redact({ ...run, ...result, status: "verified", finishedAt: new Date().toISOString() }));
    } catch (error) {
      const driverFailure = recordedDriverFailure(error);
      const parsedRun = parseRunRecord(redact({
        ...run,
        status: driverFailure?.outcome ?? "failed",
        finishedAt: new Date().toISOString(),
        events: driverFailure?.events ?? run.events,
        error: { message: sanitizeErrorMessage(error), category: driverFailure?.category ?? "unknown" },
      }));
      run = parsedRun.error ? { ...parsedRun, error: { ...parsedRun.error } } : parsedRun;
    }
    await this.store.save(run);
    return run;
  }

  /** Replays from stored input metadata while requiring fresh CSV bytes and a new driver execution. */
  async replay(runId: string, replacement: Partial<RunInput> & Pick<RunInput, "csvName" | "csvContent">): Promise<RunRecord> {
    const source = await this.requireRun(runId);
    return this.start({
      csvName: replacement.csvName,
      csvContent: replacement.csvContent,
      folderId: replacement.folderId ?? source.input.folderId,
      userId: replacement.userId ?? source.input.userId,
    }, runId);
  }

  /** Lists local sessions/runs after validating any HTTP-provided status filter. */
  list(filters: { query?: string; status?: string } = {}): Promise<RunRecord[]> {
    const normalized: RunFilters = {};
    if (filters.query !== undefined) normalized.query = filters.query;
    if (filters.status !== undefined) {
      if (!RUN_STATUSES.has(filters.status as RunStatus)) throw new Error(`Invalid run status filter: ${filters.status}`);
      normalized.status = filters.status as RunStatus;
    }
    return this.store.list(normalized);
  }

  /** Retrieves a run or raises the stable not-found error used by the HTTP adapter. */
  async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.store.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  /** Creates a standalone export only from a verified run. */
  async export(runId: string): Promise<ExportBundle> {
    return createExportBundle(await this.requireRun(runId));
  }

  /** Compares verified reports with exact decimal arithmetic and stable category ordering. */
  async compare(leftId: string, rightId: string): Promise<RunComparison> {
    const [left, right] = await Promise.all([this.requireRun(leftId), this.requireRun(rightId)]);
    if (left.status !== "verified" || right.status !== "verified" || !left.summary || !right.summary) throw new Error("Both runs must be verified before comparison");
    const leftCategories = new Set(left.summary.categories.map((item) => item.category));
    const rightCategories = new Set(right.summary.categories.map((item) => item.category));
    const categories = [...new Set([...leftCategories, ...rightCategories])].sort((first, second) => first.localeCompare(second));
    const changedCategories = categories
      .map((category) => compareCategory(left.summary, right.summary, category))
      .filter((category) => category.totalDelta !== "0.00" || category.rowCountDelta !== 0);
    return {
      leftRunId: leftId,
      rightRunId: rightId,
      totalDelta: minorUnitsToDecimal(decimalToMinorUnits(right.summary.grandTotal) - decimalToMinorUnits(left.summary.grandTotal)),
      inputRowDelta: right.summary.inputRows - left.summary.inputRows,
      reportChanged: left.summary.sha256 !== right.summary.sha256,
      addedCategories: [...rightCategories].filter((category) => !leftCategories.has(category)).sort(),
      removedCategories: [...leftCategories].filter((category) => !rightCategories.has(category)).sort(),
      changedCategories,
    };
  }
}
