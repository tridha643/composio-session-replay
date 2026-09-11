import { createHash, randomUUID } from "node:crypto";

import { Composio } from "@composio/client";
import type {
  FileCreateDownloadURLResponse,
  FileCreateUploadURLResponse,
  FileListResponse,
  RequestOptions,
  SessionExecuteMetaResponse,
  SessionExecuteResponse,
  SessionProxyExecuteResponse,
} from "@composio/client";

import { redact } from "../domain/redact.js";
import type {
  CategorySummary,
  DriverResult,
  JsonValue,
  RunInput,
  RunRecord,
  WorkflowDriver,
  WorkflowEvent,
} from "../domain/types.js";

const FILES_MOUNT_ID = "files";
const GOOGLE_DRIVE_TOOLKIT = "googledrive";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DRIVE_UPLOAD_TOOL = "GOOGLEDRIVE_UPLOAD_FROM_URL";
const REMOTE_WORKBENCH_TOOL = "COMPOSIO_REMOTE_WORKBENCH";
const MAX_INPUT_BYTES = 1024 * 1024;
const READ_OPTIONS = { maxRetries: 2 } satisfies RequestOptions;
const WRITE_OPTIONS = { maxRetries: 0 } satisfies RequestOptions;

type SdkMethod<T> = T extends (...args: infer Parameters) => infer Result
  ? (...args: Parameters) => Promise<Awaited<Result>>
  : never;

type SessionResource = Composio["toolRouter"]["session"];
type FileResource = SessionResource["files"];

/** Minimal client surface required by the workflow, derived from the installed SDK declarations. */
export interface SdkDriverClient {
  toolRouter: {
    session: {
      create: SdkMethod<SessionResource["create"]>;
      retrieve: SdkMethod<SessionResource["retrieve"]>;
      delete: SdkMethod<SessionResource["delete"]>;
      execute: SdkMethod<SessionResource["execute"]>;
      executeMeta: SdkMethod<SessionResource["executeMeta"]>;
      link: SdkMethod<SessionResource["link"]>;
      proxyExecute: SdkMethod<SessionResource["proxyExecute"]>;
      search: SdkMethod<SessionResource["search"]>;
      toolkits: SdkMethod<SessionResource["toolkits"]>;
      tools: SdkMethod<SessionResource["tools"]>;
      files: {
        list: SdkMethod<FileResource["list"]>;
        delete: SdkMethod<FileResource["delete"]>;
        createDownloadURL: SdkMethod<FileResource["createDownloadURL"]>;
        createUploadURL: SdkMethod<FileResource["createUploadURL"]>;
      };
    };
  };
}

/** Stable failure layers exposed to callers and persisted workflow events. */
export type SdkDriverErrorCategory = NonNullable<RunRecord["error"]>["category"];

/** A classified workflow failure with the sanitized events recorded before it stopped. */
export class SdkDriverError extends Error {
  readonly category: SdkDriverErrorCategory;
  readonly operation: WorkflowEvent["operation"];
  readonly outcome: "failed" | "unknown";
  readonly events: WorkflowEvent[];

  constructor(options: {
    message: string;
    category: SdkDriverErrorCategory;
    operation: WorkflowEvent["operation"];
    outcome?: "failed" | "unknown";
    events?: WorkflowEvent[];
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "SdkDriverError";
    this.category = options.category;
    this.operation = options.operation;
    this.outcome = options.outcome ?? "failed";
    this.events = options.events ? [...options.events] : [];
  }
}

/** Explicit dependencies and safety gate required to construct the live SDK driver. */
export interface SdkComposioDriverOptions {
  client: SdkDriverClient;
  /** Explicit acknowledgement because this driver creates and deletes remote resources. */
  allowLiveExecution: boolean;
  fetch?: typeof globalThis.fetch;
}

/** Environment values accepted by the live-driver factory without exposing ambient secrets. */
export interface LiveSdkDriverEnvironment {
  COMPOSIO_API_KEY?: string;
  COMPOSIO_LIVE_EXECUTION?: string;
}

interface CsvSummaryWithReport {
  categories: CategorySummary[];
  grandTotal: string;
  inputRows: number;
  report: string;
}

interface PublishedFileMetadata {
  id: string;
  mimeType: string;
  parents: string[];
  size: number;
}

interface EventFailure {
  error: {
    name: string;
    message: string;
    status?: number;
  };
  response?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"']+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        if (url.search) url.search = "?redacted";
        return url.toString();
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(/((?:api[-_]?key|token|secret|cookie|password|credential)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function eventFailure(error: unknown, response?: unknown): EventFailure {
  const name = error instanceof Error ? error.name : "Error";
  const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
  const status = errorStatus(error);
  return {
    error: status === undefined ? { name, message } : { name, message, status },
    ...(response === undefined ? {} : { response }),
  };
}

function redactDriverEventValue(value: unknown): JsonValue {
  const sanitized = redact(value);
  if (Array.isArray(sanitized)) return sanitized.map(redactDriverEventValue);
  if (!isRecord(sanitized)) return sanitized;
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, child] of Object.entries(sanitized)) {
    result[key] = /(?:^|_)link_token$/i.test(key) ? "[REDACTED]" : redactDriverEventValue(child);
  }
  return result;
}

function decimal(cents: number): string {
  const absolute = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function parseAmountToCents(raw: string, rowNumber: number): number {
  const match = raw.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`CSV validation failed: row ${rowNumber} has invalid amount ${JSON.stringify(raw)}`);
  const magnitude = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(magnitude)) throw new Error(`CSV validation failed: row ${rowNumber} amount is too large`);
  return (match[1] === "-" ? -1 : 1) * magnitude;
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (character === '"' && quoted && csv[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((column) => column.length > 0)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (quoted) throw new Error("CSV validation failed: unclosed quoted field");
  row.push(value);
  if (row.some((column) => column.length > 0)) rows.push(row);
  return rows;
}

function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function summarizeCsv(csv: string): CsvSummaryWithReport {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) throw new Error("CSV validation failed: expected a header and at least one data row");
  const headers = rows[0]!.map((column) => column.trim());
  const categoryIndex = headers.indexOf("category");
  const amountIndex = headers.indexOf("amount");
  if (categoryIndex < 0 || amountIndex < 0) throw new Error("CSV validation failed: category and amount columns are required");

  const totals = new Map<string, { rowCount: number; cents: number }>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const category = row[categoryIndex]?.trim();
    const amount = row[amountIndex];
    if (!category || amount === undefined) throw new Error(`CSV validation failed: row ${index + 1} is missing category or amount`);
    const current = totals.get(category) ?? { rowCount: 0, cents: 0 };
    const cents = current.cents + parseAmountToCents(amount, index + 1);
    if (!Number.isSafeInteger(cents)) throw new Error(`CSV validation failed: row ${index + 1} total is too large`);
    totals.set(category, { rowCount: current.rowCount + 1, cents });
  }

  const categories = [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, total]) => ({ category, rowCount: total.rowCount, total: decimal(total.cents) }));
  const grandTotal = decimal([...totals.values()].reduce((total, entry) => total + entry.cents, 0));
  const lines = categories.map((entry) => `${escapeCsvField(entry.category)},${entry.rowCount},${entry.total}`);
  return {
    categories,
    grandTotal,
    inputRows: rows.length - 1,
    report: `category,row_count,total\n${lines.join("\n")}\n`,
  };
}

function validateRunInput(input: RunInput): CsvSummaryWithReport {
  if (!input.userId.trim()) throw new Error("Live workflow validation failed: userId is required");
  if (!input.folderId.trim()) throw new Error("Live workflow validation failed: folderId is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.csv$/i.test(input.csvName) || input.csvName.includes("..")) {
    throw new Error("Live workflow validation failed: csvName must be a plain .csv filename");
  }
  const bytes = Buffer.byteLength(input.csvContent);
  if (bytes === 0 || bytes > MAX_INPUT_BYTES) {
    throw new Error(`Live workflow validation failed: CSV must contain 1 to ${MAX_INPUT_BYTES} UTF-8 bytes`);
  }
  return summarizeCsv(input.csvContent);
}

function requireSessionId(response: unknown): string {
  if (!isRecord(response) || typeof response.session_id !== "string" || !response.session_id) {
    throw new SdkDriverError({
      message: "Composio session create returned no session_id",
      category: "sdk",
      operation: "session.create",
    });
  }
  return response.session_id;
}

function validateExecutionEnvelope(
  response: SessionExecuteResponse | SessionExecuteMetaResponse,
  operation: "session.execute" | "session.executeMeta",
): void {
  if (response.error) {
    throw new SdkDriverError({ message: `${operation} returned a tool error: ${response.error}`, category: "tool", operation });
  }
  if (isRecord(response.data) && response.data.successful === false) {
    const message = typeof response.data.error === "string" ? response.data.error : "inner successful flag was false";
    throw new SdkDriverError({ message: `${operation} returned a tool error: ${message}`, category: "tool", operation });
  }
  if (isRecord(response.data) && typeof response.data.status === "number" && (response.data.status < 200 || response.data.status >= 300)) {
    throw new SdkDriverError({
      message: `${operation} returned provider status ${response.data.status}`,
      category: "provider",
      operation,
    });
  }
}

function requireProxySuccess(response: SessionProxyExecuteResponse, operation: "session.proxyExecute"): void {
  if (response.status < 200 || response.status >= 300) {
    throw new SdkDriverError({
      message: `session.proxyExecute returned provider status ${response.status}`,
      category: "provider",
      operation,
    });
  }
}

function requireUploadTool(searchResponse: unknown): void {
  if (!isRecord(searchResponse) || searchResponse.success !== true || !Array.isArray(searchResponse.results)) {
    throw new SdkDriverError({ message: "session.search did not complete successfully", category: "tool", operation: "session.search" });
  }
  const found = searchResponse.results.some((result) =>
    isRecord(result) && Array.isArray(result.primary_tool_slugs) && result.primary_tool_slugs.includes(GOOGLE_DRIVE_UPLOAD_TOOL),
  );
  if (!found) {
    throw new SdkDriverError({
      message: `session.search did not return ${GOOGLE_DRIVE_UPLOAD_TOOL}`,
      category: "tool",
      operation: "session.search",
    });
  }
}

function requireWorkbenchTool(toolsResponse: unknown): void {
  if (!isRecord(toolsResponse) || !Array.isArray(toolsResponse.items)) {
    throw new SdkDriverError({ message: "session.tools returned no items envelope", category: "sdk", operation: "session.tools" });
  }
  const found = toolsResponse.items.some((item) => isRecord(item) && item.slug === REMOTE_WORKBENCH_TOOL);
  if (!found) {
    throw new SdkDriverError({
      message: `session.tools did not expose ${REMOTE_WORKBENCH_TOOL}`,
      category: "tool",
      operation: "session.tools",
    });
  }
}

function findConnectedAccount(toolkitsResponse: unknown, expectedConnectedAccountId?: string): string | undefined {
  if (!isRecord(toolkitsResponse) || !Array.isArray(toolkitsResponse.items)) {
    throw new SdkDriverError({ message: "session.toolkits returned no items envelope", category: "sdk", operation: "session.toolkits" });
  }
  const drive = toolkitsResponse.items.find((item) => isRecord(item) && item.slug === GOOGLE_DRIVE_TOOLKIT);
  const account = isRecord(drive) && isRecord(drive.connected_account) ? drive.connected_account : undefined;
  const accountId = account && typeof account.id === "string" ? account.id : undefined;
  const isActive = account && typeof account.status === "string" && /active|connected|enabled/i.test(account.status);
  if (!accountId || !isActive) return undefined;
  if (expectedConnectedAccountId && accountId !== expectedConnectedAccountId) {
    throw new SdkDriverError({
      message: `session.toolkits selected Google Drive account ${accountId} instead of ${expectedConnectedAccountId}`,
      category: "tool",
      operation: "session.toolkits",
    });
  }
  return accountId;
}

function requireConnectedAccount(toolkitsResponse: unknown, expectedConnectedAccountId?: string): string {
  const accountId = findConnectedAccount(toolkitsResponse, expectedConnectedAccountId);
  if (!accountId) {
    throw new SdkDriverError({
      message: "session.toolkits did not confirm an active Google Drive account after session.link",
      category: "tool",
      operation: "session.toolkits",
    });
  }
  return accountId;
}

function requireLinkAccount(linkResponse: unknown, expectedConnectedAccountId?: string): string {
  const connectedAccountId = isRecord(linkResponse) && typeof linkResponse.connected_account_id === "string"
    ? linkResponse.connected_account_id
    : "";
  if (!connectedAccountId || (expectedConnectedAccountId && connectedAccountId !== expectedConnectedAccountId)) {
    throw new SdkDriverError({
      message: expectedConnectedAccountId
        ? "session.link did not resolve the explicitly selected connected account"
        : "session.link did not resolve a connected account",
      category: "tool",
      operation: "session.link",
    });
  }
  return connectedAccountId;
}

function parsePublishedFileId(response: SessionExecuteResponse): string {
  validateExecutionEnvelope(response, "session.execute");
  const toolEnvelope = response.data;
  const nestedData = isRecord(toolEnvelope.data) ? toolEnvelope.data : undefined;
  const directFile = isRecord(toolEnvelope.file) ? toolEnvelope.file : undefined;
  const nestedFile = nestedData && isRecord(nestedData.file) ? nestedData.file : undefined;
  const driveFileId = [toolEnvelope.id, nestedData?.id, directFile?.id, nestedFile?.id]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  if (!driveFileId) {
    throw new SdkDriverError({
      message: "session.execute returned an unrecognized Google Drive upload envelope; expected an id in the tool data",
      category: "tool",
      operation: "session.execute",
    });
  }
  return driveFileId;
}

function parsePublishedFileMetadata(response: SessionProxyExecuteResponse): PublishedFileMetadata {
  requireProxySuccess(response, "session.proxyExecute");
  if (!isRecord(response.data)) {
    throw new SdkDriverError({ message: "Google Drive metadata response contained no data object", category: "provider", operation: "session.proxyExecute" });
  }
  const size = typeof response.data.size === "string" ? Number(response.data.size) : response.data.size;
  if (
    typeof response.data.id !== "string" ||
    typeof response.data.mimeType !== "string" ||
    !Array.isArray(response.data.parents) ||
    !response.data.parents.every((parent) => typeof parent === "string") ||
    typeof size !== "number" ||
    !Number.isFinite(size)
  ) {
    throw new SdkDriverError({ message: "Google Drive metadata response had an unexpected shape", category: "provider", operation: "session.proxyExecute" });
  }
  return { id: response.data.id, mimeType: response.data.mimeType, parents: response.data.parents, size };
}

function workbenchProgram(parametersAbsolutePath: string): string {
  return `import csv
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path

parameters = json.loads(Path(${JSON.stringify(parametersAbsolutePath)}).read_text(encoding="utf-8"))
input_path = Path(parameters["input_path"])
output_path = Path(parameters["output_path"])
totals = {}
with input_path.open(newline="", encoding="utf-8") as source:
    reader = csv.DictReader(source)
    if reader.fieldnames is None or "category" not in reader.fieldnames or "amount" not in reader.fieldnames:
        raise ValueError("CSV requires category and amount columns")
    for row_number, row in enumerate(reader, start=2):
        category = (row.get("category") or "").strip()
        amount_text = (row.get("amount") or "").strip()
        if not category:
            raise ValueError(f"row {row_number} has no category")
        try:
            amount = Decimal(amount_text)
        except InvalidOperation as error:
            raise ValueError(f"row {row_number} has invalid amount") from error
        if amount.as_tuple().exponent < -2:
            raise ValueError(f"row {row_number} has more than two decimal places")
        count, total = totals.get(category, (0, Decimal("0.00")))
        totals[category] = (count + 1, total + amount)
output_path.parent.mkdir(parents=True, exist_ok=True)
with output_path.open("w", newline="", encoding="utf-8") as destination:
    writer = csv.writer(destination, lineterminator="\\n")
    writer.writerow(["category", "row_count", "total"])
    for category in sorted(totals):
        count, total = totals[category]
        writer.writerow([category, count, format(total, ".2f")])
print(json.dumps({"output_path": parameters["output_path"], "rows": sum(item[0] for item in totals.values())}))`;
}

/** Executes the fixed CSV-to-Google-Drive workflow through @composio/client. */
export class SdkComposioDriver implements WorkflowDriver {
  readonly mode = "live" as const;
  private readonly client: SdkDriverClient;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly events: WorkflowEvent[] = [];

  constructor(options: SdkComposioDriverOptions) {
    if (!options.allowLiveExecution) {
      throw new Error("Live Composio execution is disabled; set an explicit live execution gate before constructing the SDK driver");
    }
    this.client = options.client;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async execute(input: RunInput): Promise<DriverResult> {
    this.events.length = 0;
    let expected: CsvSummaryWithReport;
    try {
      expected = validateRunInput(input);
    } catch (error) {
      throw new SdkDriverError({
        message: error instanceof Error ? error.message : String(error),
        category: "validation",
        operation: "session.create",
        cause: error,
      });
    }

    const runPath = `runs/${randomUUID()}`;
    const inputPath = `${runPath}/${input.csvName}`;
    const outputName = input.csvName.replace(/\.csv$/i, "-summary.csv");
    const outputPath = `${runPath}/${outputName}`;
    const parametersPath = `${runPath}/parameters.json`;
    let sessionId: string | undefined;

    try {
      const createRequest = {
        user_id: input.userId,
        toolkits: { enable: [GOOGLE_DRIVE_TOOLKIT] },
        workbench: { enable: true, enable_proxy_execution: true },
      };
      const createResponse = await this.recordSdk(
        "support",
        "session.create",
        createRequest,
        "write",
        () => this.client.toolRouter.session.create(createRequest, WRITE_OPTIONS),
      );
      sessionId = requireSessionId(createResponse);

      await this.recordSdk("support", "session.retrieve", { sessionId }, "read", () =>
        this.client.toolRouter.session.retrieve(sessionId!, READ_OPTIONS));

      const initialToolkits = await this.recordSdk("sdk", "session.toolkits", { sessionId, is_connected: true }, "read", () =>
        this.client.toolRouter.session.toolkits(sessionId!, { toolkits: [GOOGLE_DRIVE_TOOLKIT], is_connected: true, limit: 50 }, READ_OPTIONS),
      );
      const toolsResponse = await this.recordSdk("sdk", "session.tools", { sessionId, limit: 500 }, "read", () =>
        this.client.toolRouter.session.tools(sessionId!, { limit: 500 }, READ_OPTIONS));
      requireWorkbenchTool(toolsResponse);

      const searchResponse = await this.recordSdk(
        "sdk",
        "session.search",
        { sessionId, queries: [{ use_case: "upload a CSV report to Google Drive from a URL" }], search_strategy: "tool_search" },
        "read",
        () => this.client.toolRouter.session.search(sessionId!, {
          queries: [{ use_case: "upload a CSV report to Google Drive from a URL" }],
          search_strategy: "tool_search",
        }, READ_OPTIONS),
      );
      requireUploadTool(searchResponse);

      if (!findConnectedAccount(initialToolkits)) {
        const linkResponse = await this.recordSdk("sdk", "session.link", { sessionId, toolkit: GOOGLE_DRIVE_TOOLKIT }, "write", () =>
          this.client.toolRouter.session.link(sessionId!, { toolkit: GOOGLE_DRIVE_TOOLKIT }, WRITE_OPTIONS));
        const pendingAccountId = requireLinkAccount(linkResponse);
        const connectedToolkits = await this.recordSdk("sdk", "session.toolkits", { sessionId, is_connected: true }, "read", () =>
          this.client.toolRouter.session.toolkits(sessionId!, { toolkits: [GOOGLE_DRIVE_TOOLKIT], is_connected: true, limit: 50 }, READ_OPTIONS));
        requireConnectedAccount(connectedToolkits, pendingAccountId);
      }

      const folderPreflight = await this.recordSdk(
        "sdk",
        "session.proxyExecute",
        { sessionId, toolkit_slug: GOOGLE_DRIVE_TOOLKIT, endpoint: `/files/${input.folderId}`, method: "GET" },
        "read",
        () => this.client.toolRouter.session.proxyExecute(sessionId!, {
          toolkit_slug: GOOGLE_DRIVE_TOOLKIT,
          endpoint: `/files/${encodeURIComponent(input.folderId)}`,
          method: "GET",
          parameters: [{ name: "fields", value: "id,mimeType,trashed", type: "query" }],
        }, READ_OPTIONS),
      );
      requireProxySuccess(folderPreflight, "session.proxyExecute");
      if (!isRecord(folderPreflight.data) || folderPreflight.data.id !== input.folderId || folderPreflight.data.mimeType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE || folderPreflight.data.trashed === true) {
        throw new SdkDriverError({ message: "Google Drive destination preflight did not confirm an accessible folder", category: "provider", operation: "session.proxyExecute" });
      }

      const inputUpload = await this.uploadMountFile(sessionId, inputPath, "text/csv", Buffer.from(input.csvContent, "utf8"));
      const parameters = Buffer.from(JSON.stringify({
        input_path: `${inputUpload.sandbox_mount_prefix}/${inputPath}`,
        output_path: `${inputUpload.sandbox_mount_prefix}/${outputPath}`,
      }), "utf8");
      const parametersUpload = await this.uploadMountFile(sessionId, parametersPath, "application/json", parameters);

      const inputFiles = await this.listAllMountFiles(sessionId, runPath);
      this.requireListedFile(inputFiles, inputPath, Buffer.byteLength(input.csvContent));
      this.requireListedFile(inputFiles, parametersPath, parameters.byteLength);
      const stagedInput = await this.downloadMountFile(sessionId, inputPath);
      if (!stagedInput.equals(Buffer.from(input.csvContent, "utf8"))) {
        throw new SdkDriverError({ message: "Signed URL input verification returned different bytes", category: "transfer", operation: "signed-url.get" });
      }

      const metaResponse = await this.recordSdk(
        "sdk",
        "session.executeMeta",
        { sessionId, slug: REMOTE_WORKBENCH_TOOL, arguments: { template: "csv-summary-v1", parameters_path: parametersPath } },
        "write",
        () => this.client.toolRouter.session.executeMeta(sessionId!, {
          slug: REMOTE_WORKBENCH_TOOL,
          arguments: {
            code_to_execute: workbenchProgram(`${parametersUpload.sandbox_mount_prefix}/${parametersPath}`),
            thought: "Generate the deterministic CSV category summary",
            current_step: "GENERATING_REPORT",
            current_step_metric: `0/${expected.inputRows} rows`,
            session_id: sessionId,
          },
        }, WRITE_OPTIONS),
      );
      validateExecutionEnvelope(metaResponse, "session.executeMeta");

      const outputFiles = await this.listAllMountFiles(sessionId, runPath);
      this.requireListedFile(outputFiles, outputPath, Buffer.byteLength(expected.report));
      const reportBytes = await this.downloadMountFile(sessionId, outputPath);
      const expectedBytes = Buffer.from(expected.report, "utf8");
      if (!reportBytes.equals(expectedBytes)) {
        throw new SdkDriverError({ message: "Generated report bytes did not match the independently computed report", category: "tool", operation: "session.executeMeta" });
      }
      const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");

      const reportDownload = await this.createDownloadURL(sessionId, outputPath);
      const executeResponse = await this.recordSdk(
        "sdk",
        "session.execute",
        {
          sessionId,
          tool_slug: GOOGLE_DRIVE_UPLOAD_TOOL,
          arguments: { source_url: reportDownload.download_url, name: outputName, parent_folder_id: input.folderId, mime_type: "text/csv" },
        },
        "write",
        () => this.client.toolRouter.session.execute(sessionId!, {
          tool_slug: GOOGLE_DRIVE_UPLOAD_TOOL,
          arguments: { source_url: reportDownload.download_url, name: outputName, parent_folder_id: input.folderId, mime_type: "text/csv" },
        }, WRITE_OPTIONS),
      );
      const driveFileId = parsePublishedFileId(executeResponse);

      const metadataResponse = await this.recordSdk(
        "sdk",
        "session.proxyExecute",
        { sessionId, toolkit_slug: GOOGLE_DRIVE_TOOLKIT, endpoint: `/files/${driveFileId}`, method: "GET" },
        "read",
        () => this.client.toolRouter.session.proxyExecute(sessionId!, {
          toolkit_slug: GOOGLE_DRIVE_TOOLKIT,
          endpoint: `/files/${encodeURIComponent(driveFileId)}`,
          method: "GET",
          parameters: [{ name: "fields", value: "id,name,parents,mimeType,size,trashed", type: "query" }],
        }, READ_OPTIONS),
      );
      const metadata = parsePublishedFileMetadata(metadataResponse);
      if (metadata.id !== driveFileId || metadata.mimeType !== "text/csv" || !metadata.parents.includes(input.folderId) || metadata.size !== reportBytes.byteLength) {
        throw new SdkDriverError({ message: "Published Google Drive metadata did not match the selected folder and report", category: "provider", operation: "session.proxyExecute" });
      }

      const contentResponse = await this.recordSdk(
        "sdk",
        "session.proxyExecute",
        { sessionId, toolkit_slug: GOOGLE_DRIVE_TOOLKIT, endpoint: `/files/${driveFileId}`, method: "GET", alt: "media" },
        "read",
        () => this.client.toolRouter.session.proxyExecute(sessionId!, {
          toolkit_slug: GOOGLE_DRIVE_TOOLKIT,
          endpoint: `/files/${encodeURIComponent(driveFileId)}`,
          method: "GET",
          parameters: [{ name: "alt", value: "media", type: "query" }],
        }, READ_OPTIONS),
      );
      requireProxySuccess(contentResponse, "session.proxyExecute");
      const publishedBytes = typeof contentResponse.data === "string"
        ? Buffer.from(contentResponse.data, "utf8")
        : contentResponse.binary_data?.url
          ? await this.getSignedURL(contentResponse.binary_data.url)
          : undefined;
      if (!publishedBytes) {
        throw new SdkDriverError({ message: "Google Drive content proxy returned neither inline text nor a binary download URL", category: "provider", operation: "session.proxyExecute" });
      }
      if (!publishedBytes.equals(reportBytes)) {
        throw new SdkDriverError({ message: "Published Google Drive bytes did not match the verified report", category: "provider", operation: "session.proxyExecute" });
      }

      await this.cleanupOwnedResources(sessionId, runPath, true);
      return {
        composioSessionId: sessionId,
        events: [...this.events],
        summary: { categories: expected.categories, grandTotal: expected.grandTotal, inputRows: expected.inputRows, sha256: reportSha256 },
        artifacts: [
          { name: input.csvName, kind: "input", value: inputPath },
          { name: outputName, kind: "report", value: outputPath },
          { name: outputName, kind: "published", value: driveFileId },
        ],
      };
    } catch (error) {
      if (error instanceof SdkDriverError) this.reclassifyLastSuccessfulEvent(error);
      if (sessionId) await this.cleanupOwnedResources(sessionId, runPath, false);
      if (error instanceof SdkDriverError) {
        throw new SdkDriverError({
          message: error.message,
          category: error.category,
          operation: error.operation,
          outcome: error.outcome,
          events: this.events,
          cause: error.cause,
        });
      }
      throw new SdkDriverError({
        message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        category: "unknown",
        operation: sessionId ? "session.delete" : "session.create",
        events: this.events,
        cause: error,
      });
    }
  }

  private async recordSdk<Result>(
    kind: WorkflowEvent["kind"],
    operation: WorkflowEvent["operation"],
    input: unknown,
    effect: "read" | "write",
    request: () => Promise<Result>,
  ): Promise<Result> {
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const output = await request();
      this.events.push(this.makeEvent(kind, operation, "success", startedAt, startedMs, input, output));
      return output;
    } catch (error) {
      const known = error instanceof SdkDriverError;
      const outcome = known ? error.outcome : effect === "write" ? "unknown" : "failed";
      this.events.push(this.makeEvent(
        kind,
        operation,
        outcome === "unknown" ? "unknown" : "error",
        startedAt,
        startedMs,
        input,
        eventFailure(error),
        known ? error.category : "sdk",
      ));
      throw known ? error : new SdkDriverError({
        message: `${operation} SDK request failed: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`,
        category: "sdk",
        operation,
        outcome,
        cause: error,
      });
    }
  }

  private makeEvent(
    kind: WorkflowEvent["kind"],
    operation: WorkflowEvent["operation"],
    status: "success" | "error" | "unknown",
    startedAt: Date,
    startedMs: number,
    input: unknown,
    output: unknown,
    errorCategory: SdkDriverErrorCategory = "unknown",
  ): WorkflowEvent {
    const event = {
      id: randomUUID(),
      kind,
      operation,
      startedAt: startedAt.toISOString(),
      durationMs: Math.max(0, Date.now() - startedMs),
      input: redactDriverEventValue(input),
      output: redactDriverEventValue(output),
    };
    if (status === "success") return { ...event, status };
    const failure = isRecord(output) && isRecord(output.error) ? output.error : undefined;
    const message = failure && typeof failure.message === "string" ? failure.message : `${operation} failed`;
    return { ...event, status, error: { message, category: errorCategory } };
  }

  private reclassifyLastSuccessfulEvent(error: SdkDriverError): void {
    const index = this.events.length - 1;
    const event = this.events[index];
    if (!event || event.operation !== error.operation || event.status !== "success") return;
    this.events[index] = {
      ...event,
      status: error.outcome === "unknown" ? "unknown" : "error",
      error: { message: sanitizeErrorMessage(error.message), category: error.category },
    };
  }

  private async uploadMountFile(sessionId: string, path: string, mimetype: string, bytes: Buffer): Promise<FileCreateUploadURLResponse> {
    const upload = await this.recordSdk(
      "sdk",
      "session.files.createUploadURL",
      { mountId: FILES_MOUNT_ID, session_id: sessionId, mount_relative_path: path, mimetype },
      "write",
      () => this.client.toolRouter.session.files.createUploadURL(FILES_MOUNT_ID, {
        session_id: sessionId,
        mount_relative_path: path,
        mimetype,
      }, WRITE_OPTIONS),
    );
    await this.putSignedURL(upload.upload_url, bytes, mimetype);
    return upload;
  }

  private async createDownloadURL(sessionId: string, path: string): Promise<FileCreateDownloadURLResponse> {
    return this.recordSdk(
      "sdk",
      "session.files.createDownloadURL",
      { mountId: FILES_MOUNT_ID, session_id: sessionId, mount_relative_path: path },
      "read",
      () => this.client.toolRouter.session.files.createDownloadURL(FILES_MOUNT_ID, {
        session_id: sessionId,
        mount_relative_path: path,
      }, WRITE_OPTIONS),
    );
  }

  private async downloadMountFile(sessionId: string, path: string): Promise<Buffer> {
    const download = await this.createDownloadURL(sessionId, path);
    return this.getSignedURL(download.download_url);
  }

  private async listAllMountFiles(sessionId: string, prefix: string): Promise<FileListResponse["items"]> {
    const items: FileListResponse["items"] = [];
    let cursor: string | undefined;
    do {
      const query = cursor
        ? { session_id: sessionId, mount_relative_prefix: prefix, limit: 500, cursor }
        : { session_id: sessionId, mount_relative_prefix: prefix, limit: 500 };
      const page = await this.recordSdk(
        "sdk",
        "session.files.list",
        { mountId: FILES_MOUNT_ID, ...query },
        "read",
        () => this.client.toolRouter.session.files.list(FILES_MOUNT_ID, query, READ_OPTIONS),
      );
      items.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return items;
  }

  private requireListedFile(items: FileListResponse["items"], path: string, size: number): void {
    const exact = items.find((item) => item.mount_relative_path === path);
    if (!exact || exact.size !== size) {
      throw new SdkDriverError({
        message: `session.files.list did not confirm ${path} with ${size} bytes`,
        category: "transfer",
        operation: "session.files.list",
      });
    }
  }

  private async putSignedURL(url: string, bytes: Buffer, mimetype: string): Promise<void> {
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const body = Uint8Array.from(bytes).buffer;
      const response = await this.fetchImplementation(url, { method: "PUT", headers: { "content-type": mimetype }, body });
      if (!response.ok) throw new Error(`Signed URL PUT returned HTTP ${response.status}`);
      this.events.push(this.makeEvent("transfer", "signed-url.put", "success", startedAt, startedMs, { url, bytes: bytes.byteLength, mimetype }, { status: response.status }));
    } catch (error) {
      const outcome = error instanceof TypeError ? "unknown" : "failed";
      this.events.push(this.makeEvent("transfer", "signed-url.put", outcome === "unknown" ? "unknown" : "error", startedAt, startedMs, { url, bytes: bytes.byteLength, mimetype }, eventFailure(error), "transfer"));
      throw new SdkDriverError({
        message: `Signed URL PUT failed: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`,
        category: "transfer",
        operation: "signed-url.put",
        outcome,
        cause: error,
      });
    }
  }

  private async getSignedURL(url: string): Promise<Buffer> {
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const response = await this.fetchImplementation(url, { method: "GET" });
      if (!response.ok) throw new Error(`Signed URL GET returned HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      this.events.push(this.makeEvent("transfer", "signed-url.get", "success", startedAt, startedMs, { url }, {
        status: response.status,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }));
      return bytes;
    } catch (error) {
      this.events.push(this.makeEvent("transfer", "signed-url.get", "error", startedAt, startedMs, { url }, eventFailure(error), "transfer"));
      throw new SdkDriverError({
        message: `Signed URL GET failed: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`,
        category: "transfer",
        operation: "signed-url.get",
        cause: error,
      });
    }
  }

  private async cleanupOwnedResources(sessionId: string, runPath: string, strict: boolean): Promise<void> {
    try {
      const ownedFiles = await this.listAllMountFiles(sessionId, runPath);
      for (const file of ownedFiles) {
        await this.recordSdk(
          "sdk",
          "session.files.delete",
          { mountId: FILES_MOUNT_ID, session_id: sessionId, mount_relative_path: file.mount_relative_path },
          "write",
          () => this.client.toolRouter.session.files.delete(FILES_MOUNT_ID, {
            session_id: sessionId,
            mount_relative_path: file.mount_relative_path,
          }, WRITE_OPTIONS),
        );
      }
      if (strict) {
        const remaining = await this.listAllMountFiles(sessionId, runPath);
        if (remaining.length > 0) throw new SdkDriverError({ message: "Mount cleanup left run-owned files behind", category: "sdk", operation: "session.files.delete" });
      }
    } catch (error) {
      if (strict) throw error;
    }

    try {
      await this.recordSdk("sdk", "session.delete", { sessionId }, "write", () =>
        this.client.toolRouter.session.delete(sessionId, WRITE_OPTIONS));
      try {
        await this.client.toolRouter.session.retrieve(sessionId, READ_OPTIONS);
        const error = new SdkDriverError({ message: "Session remained retrievable after deletion", category: "sdk", operation: "session.retrieve" });
        this.events.push(this.makeEvent("support", "session.retrieve", "error", new Date(), Date.now(), { sessionId }, eventFailure(error)));
        if (strict) throw error;
      } catch (error) {
        if (error instanceof SdkDriverError) throw error;
        if (errorStatus(error) !== 404) {
          this.events.push(this.makeEvent("support", "session.retrieve", "error", new Date(), Date.now(), { sessionId }, eventFailure(error)));
          if (strict) throw new SdkDriverError({ message: "Session deletion verification did not return 404", category: "sdk", operation: "session.retrieve", cause: error });
        } else {
          this.events.push(this.makeEvent("support", "session.retrieve", "success", new Date(), Date.now(), { sessionId }, { status: 404, verified_deleted: true }));
        }
      }
    } catch (error) {
      if (strict) throw error;
    }
  }
}

/** Builds the real client only when COMPOSIO_LIVE_EXECUTION=1 and the project API key is explicit. */
export function createLiveSdkComposioDriverFromEnv(
  environment: LiveSdkDriverEnvironment = process.env,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): SdkComposioDriver {
  if (environment.COMPOSIO_LIVE_EXECUTION !== "1") {
    throw new Error("Live Composio execution is disabled; set COMPOSIO_LIVE_EXECUTION=1 explicitly");
  }
  const apiKey = environment.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error("Live Composio execution requires COMPOSIO_API_KEY");
  }
  const client = new Composio({ apiKey, maxRetries: 0, fetch: fetchImplementation });
  return new SdkComposioDriver({
    client,
    allowLiveExecution: true,
    fetch: fetchImplementation,
  });
}
