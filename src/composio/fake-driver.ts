import { createHash, randomUUID } from "node:crypto";

import { redact } from "../domain/redact.js";
import type { CategorySummary, DriverResult, RunInput, WorkflowDriver, WorkflowEvent } from "../domain/types.js";

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { values.push(value); value = ""; }
    else value += character;
  }
  if (quoted) throw new Error("Malformed CSV: unclosed quote");
  values.push(value);
  return values;
}

function parseAmountToCents(raw: string): bigint {
  const match = raw.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Invalid amount: ${raw}`);
  const magnitude = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -magnitude : magnitude;
}

function decimal(cents: bigint): string {
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

function summarizeCsv(csv: string): { categories: CategorySummary[]; grandTotal: string; inputRows: number; report: string } {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV must contain a header and at least one row");
  const headers = parseCsvLine(lines[0]!).map((value) => value.trim());
  const categoryIndex = headers.indexOf("category");
  const amountIndex = headers.indexOf("amount");
  if (categoryIndex < 0 || amountIndex < 0) throw new Error("CSV requires category and amount columns");
  const totals = new Map<string, { count: number; cents: bigint }>();
  for (const line of lines.slice(1)) {
    const columns = parseCsvLine(line);
    const category = columns[categoryIndex]?.trim();
    const rawAmount = columns[amountIndex];
    if (!category || rawAmount === undefined) throw new Error("CSV row is missing category or amount");
    const current = totals.get(category) ?? { count: 0, cents: 0n };
    totals.set(category, { count: current.count + 1, cents: current.cents + parseAmountToCents(rawAmount) });
  }
  const categories = [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, value]) => ({ category, rowCount: value.count, total: decimal(value.cents) }));
  const grandTotal = decimal([...totals.values()].reduce((total, value) => total + value.cents, 0n));
  const report = `category,row_count,total\n${categories.map((item) => `${item.category},${item.rowCount},${item.total}`).join("\n")}\n`;
  return { categories, grandTotal, inputRows: lines.length - 1, report };
}

function event(kind: WorkflowEvent["kind"], operation: WorkflowEvent["operation"], input: unknown, output: unknown): WorkflowEvent {
  return { id: randomUUID(), kind, operation, status: "success", startedAt: new Date().toISOString(), durationMs: 1, input: redact(input), output: redact(output) };
}

export class FakeComposioDriver implements WorkflowDriver {
  readonly mode = "fake" as const;

  async execute(input: RunInput): Promise<DriverResult> {
    const sessionId = `session_${randomUUID()}`;
    const runPath = `runs/${randomUUID()}`;
    const inputPath = `${runPath}/${input.csvName}`;
    const outputName = input.csvName.replace(/\.csv$/i, "-summary.csv");
    const outputPath = `${runPath}/${outputName}`;
    const { categories, grandTotal, inputRows, report } = summarizeCsv(input.csvContent);
    const sha256 = createHash("sha256").update(report).digest("hex");
    const uploadUrl = `https://storage.example/upload/${sessionId}?token=fake-secret`;
    const downloadUrl = `https://storage.example/download/${sessionId}?signature=fake-secret`;
    const driveFileId = `drive_${randomUUID()}`;
    const events: WorkflowEvent[] = [
      event("support", "session.create", { user_id: input.userId, workbench: { enable: true }, enable_proxy_execution: true }, { id: sessionId }),
      event("sdk", "session.toolkits", { sessionId }, { items: [{ slug: "googledrive", connected: true }] }),
      event("sdk", "session.tools", { sessionId }, { items: [{ slug: "COMPOSIO_REMOTE_WORKBENCH" }] }),
      event("sdk", "session.search", { sessionId, queries: [{ use_case: "upload a CSV report to Google Drive" }] }, { primary_tool_slugs: ["GOOGLEDRIVE_UPLOAD_FROM_URL"] }),
      event("sdk", "session.link", { sessionId, toolkit: "googledrive" }, { status: "already_connected" }),
      event("sdk", "session.files.createUploadURL", { mountId: "files", session_id: sessionId, mount_relative_path: inputPath, mimetype: "text/csv" }, { upload_url: uploadUrl, mount_relative_path: inputPath }),
      event("transfer", "signed-url.put", { url: uploadUrl, bytes: Buffer.byteLength(input.csvContent) }, { status: 200 }),
      event("sdk", "session.files.list", { mountId: "files", session_id: sessionId, path: runPath }, { items: [{ path: inputPath, size: Buffer.byteLength(input.csvContent) }, { path: outputPath, size: Buffer.byteLength(report) }] }),
      event("sdk", "session.executeMeta", { sessionId, tool_slug: "COMPOSIO_REMOTE_WORKBENCH", arguments: { template: "csv-summary-v1", parameters_path: `${runPath}/parameters.json` } }, { output_path: outputPath, exit_code: 0 }),
      event("sdk", "session.files.createDownloadURL", { mountId: "files", session_id: sessionId, mount_relative_path: outputPath }, { download_url: downloadUrl }),
      event("transfer", "signed-url.get", { url: downloadUrl }, { status: 200, bytes: Buffer.byteLength(report), sha256 }),
      event("sdk", "session.execute", { sessionId, tool_slug: "GOOGLEDRIVE_UPLOAD_FROM_URL", arguments: { source_url: downloadUrl, name: outputName, parent_folder_id: input.folderId, mime_type: "text/csv" } }, { successful: true, data: { id: driveFileId } }),
      event("sdk", "session.proxyExecute", { sessionId, toolkit_slug: "googledrive", endpoint: `/drive/v3/files/${driveFileId}`, method: "GET" }, { status: 200, data: { id: driveFileId, parents: [input.folderId], mimeType: "text/csv", sha256 } }),
      event("sdk", "session.files.delete", { mountId: "files", session_id: sessionId, mount_relative_path: runPath }, { deleted: true }),
      event("sdk", "session.delete", { sessionId }, { deleted: true }),
      event("support", "session.retrieve", { sessionId }, { status: 404, verified_deleted: true }),
    ];
    return {
      composioSessionId: sessionId,
      events,
      summary: { categories, grandTotal, inputRows, sha256 },
      artifacts: [
        { name: input.csvName, kind: "input", value: inputPath },
        { name: outputName, kind: "report", value: outputPath },
        { name: outputName, kind: "published", value: driveFileId },
      ],
    };
  }
}
