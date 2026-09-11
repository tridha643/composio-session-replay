import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExportBundle, RunRecord } from "./types.js";

const REQUIRED_EXPORT_FILES = ["src/workflow.ts", "src/runner.ts", "report.py", "package.json", "package-lock.json", "tsconfig.json", ".env.example", "input.example.json", "README.md"] as const;
const SECRET_ASSIGNMENT = /(?:COMPOSIO_API_KEY|authorization|access_token|refresh_token|cookie|password)\s*[:=]\s*["']?(?!\s|["']|<|\$\{)[^\s,"'}]+/i;
const CREDENTIAL_BEARING_URL = /https?:[^\s"']+[?&](?:token|signature|sig|x-amz-(?:credential|signature|security-token))=/i;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

interface PackageLockDocument {
  name: string;
  version: string;
  packages: Record<string, unknown> & { "": Record<string, unknown> };
  [key: string]: unknown;
}

function createExportPackageLock(): string {
  const sourceCandidates = [
    fileURLToPath(new URL("../../package-lock.json", import.meta.url)),
    path.resolve("package-lock.json"),
  ];
  let serialized: string | null = null;
  for (const filename of sourceCandidates) {
    try {
      serialized = readFileSync(filename, "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!serialized) throw new Error("Export package lock source is unavailable");
  const lock = JSON.parse(serialized) as PackageLockDocument;
  if (!lock.packages?.[""]) throw new Error("Export package lock source has no root package");
  lock.name = "composio-replay-export";
  lock.version = "1.0.0";
  lock.packages[""].name = lock.name;
  lock.packages[""].version = lock.version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

const REPORT_TEMPLATE = `import csv
import json
import re
from decimal import Decimal, InvalidOperation

with open(PARAMETERS_PATH, encoding="utf-8") as parameters_file:
    parameters = json.load(parameters_file)

totals = {}
row_count = 0
with open(parameters["input_path"], newline="", encoding="utf-8") as input_file:
    reader = csv.DictReader(input_file)
    if not reader.fieldnames or not {"category", "amount"}.issubset(reader.fieldnames):
        raise ValueError("CSV requires category and amount columns")
    for row_number, row in enumerate(reader, start=2):
        category = (row.get("category") or "").strip()
        if not category:
            raise ValueError(f"row {row_number}: category is required")
        raw_amount = row.get("amount") or ""
        if not re.fullmatch(r"-?\\d+(?:\\.\\d{1,2})?", raw_amount):
            raise ValueError(f"row {row_number}: invalid amount")
        try:
            amount = Decimal(raw_amount)
        except InvalidOperation as error:
            raise ValueError(f"row {row_number}: invalid amount") from error
        count, total = totals.get(category, (0, Decimal("0.00")))
        totals[category] = (count + 1, total + amount)
        row_count += 1

with open(parameters["output_path"], "w", newline="", encoding="utf-8") as output_file:
    writer = csv.writer(output_file, lineterminator="\\n")
    writer.writerow(["category", "row_count", "total"])
    for category in sorted(totals):
        count, total = totals[category]
        writer.writerow([category, count, f"{total:.2f}"])
`;

const STANDALONE_RUNNER = `import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Composio } from "@composio/client";
import { workflow } from "./workflow.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(\`Invalid \${label} response\`);
  return value as JsonObject;
}

function findString(value: unknown, keys: ReadonlySet<string>): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string" && child) return child;
    const nested = findString(child, keys);
    if (nested) return nested;
  }
  return null;
}

async function putFile(url: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const response = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: Buffer.from(bytes) });
  if (!response.ok) throw new Error(\`Signed URL PUT failed with \${response.status}\`);
}

const [csvFilename, configFilename = "input.json"] = process.argv.slice(2);
if (!csvFilename) throw new Error("Usage: npm start -- <input.csv> [input.json]");
if (!process.env.COMPOSIO_API_KEY) throw new Error("COMPOSIO_API_KEY is required");
const config = object(JSON.parse(await readFile(configFilename, "utf8")), "input configuration");
const userId = typeof config.userId === "string" ? config.userId : "";
const folderId = typeof config.folderId === "string" ? config.folderId : "";
if (!userId || !folderId) throw new Error("input.json requires userId and folderId");

const csv = await readFile(csvFilename);
const reportScript = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "../report.py"));
const client = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, maxRetries: 0 });
const sessionRequest = {
  user_id: userId,
  toolkits: { enable: ["googledrive"] },
  workbench: { enable: true, enable_proxy_execution: true },
};
const session = await client.toolRouter.session.create(sessionRequest);
const sessionId = session.session_id;
const link = await client.toolRouter.session.link(sessionId, { toolkit: "googledrive" }, { maxRetries: 0 });
const connectedAccountId = typeof link.connected_account_id === "string" ? link.connected_account_id : "";
if (!connectedAccountId) throw new Error("session.link did not resolve a Google Drive account");
const runPath = \`runs/\${randomUUID()}\`;
const inputPath = \`\${runPath}/input.csv\`;
const reportPath = \`\${runPath}/report.csv\`;
const parametersPath = \`\${runPath}/parameters.json\`;
const scriptPath = \`\${runPath}/report.py\`;
const ownedPaths = [inputPath, reportPath, parametersPath, scriptPath];

async function upload(relativePath: string, bytes: Uint8Array, mimetype: string): Promise<string> {
  const ticket = await client.toolRouter.session.files.createUploadURL("files", { session_id: sessionId, mount_relative_path: relativePath, mimetype });
  await putFile(ticket.upload_url, bytes, mimetype);
  return ticket.sandbox_mount_prefix;
}

try {
  const mountPrefix = await upload(inputPath, csv, "text/csv");
  const inputAbsolutePath = \`\${mountPrefix}/\${inputPath}\`;
  const reportAbsolutePath = \`\${mountPrefix}/\${reportPath}\`;
  const scriptAbsolutePath = \`\${mountPrefix}/\${scriptPath}\`;
  const parametersAbsolutePath = \`\${mountPrefix}/\${parametersPath}\`;
  const parameters = Buffer.from(JSON.stringify({ input_path: inputAbsolutePath, output_path: reportAbsolutePath }));
  await upload(parametersPath, parameters, "application/json");
  await upload(scriptPath, reportScript, "text/x-python");
  const metaResult = await client.toolRouter.session.executeMeta(sessionId, {
    slug: "COMPOSIO_REMOTE_WORKBENCH",
    arguments: {
      code_to_execute: "import runpy; runpy.run_path(" + JSON.stringify(scriptAbsolutePath) + ", init_globals={\\"PARAMETERS_PATH\\": " + JSON.stringify(parametersAbsolutePath) + "})",
    },
  }, { maxRetries: 0 });
  if (findString(metaResult, new Set(["error", "error_message"]))) throw new Error("Workbench report generation returned an error");

  const download = await client.toolRouter.session.files.createDownloadURL("files", { session_id: sessionId, mount_relative_path: reportPath });
  const reportResponse = await fetch(download.download_url);
  if (!reportResponse.ok) throw new Error(\`Signed URL GET failed with \${reportResponse.status}\`);
  const report = new Uint8Array(await reportResponse.arrayBuffer());
  if (!report.length) throw new Error("Generated report is empty");
  const digest = createHash("sha256").update(report).digest("hex");

  const publish = await client.toolRouter.session.execute(sessionId, {
    tool_slug: "GOOGLEDRIVE_UPLOAD_FROM_URL",
    arguments: { source_url: download.download_url, name: path.basename(csvFilename, path.extname(csvFilename)) + "-summary.csv", parent_folder_id: folderId, mime_type: "text/csv" },
  }, { maxRetries: 0 });
  if (publish.error) throw new Error(\`Google Drive upload failed: \${publish.error}\`);
  const driveFileId = findString(publish.data, new Set(["id", "file_id", "fileId"]));
  if (!driveFileId) throw new Error("Google Drive upload returned no file ID");

  const metadataVerification = await client.toolRouter.session.proxyExecute(sessionId, {
    toolkit_slug: "googledrive",
    endpoint: \`/files/\${encodeURIComponent(driveFileId)}?fields=id,parents,mimeType,size\`,
    method: "GET",
  });
  const metadataObject = object(metadataVerification, "proxy metadata verification");
  if (typeof metadataObject.status === "number" && metadataObject.status >= 400) throw new Error(\`Drive metadata verification failed with \${metadataObject.status}\`);
  const metadata = JSON.stringify(metadataVerification);
  if (!metadata.includes(driveFileId) || !metadata.includes(folderId) || !metadata.includes("text/csv")) throw new Error("Drive metadata does not match the published report");

  const contentVerification = await client.toolRouter.session.proxyExecute(sessionId, {
    toolkit_slug: "googledrive",
    endpoint: \`/files/\${encodeURIComponent(driveFileId)}?alt=media\`,
    method: "GET",
  });
  const contentObject = object(contentVerification, "proxy content verification");
  if (typeof contentObject.status === "number" && contentObject.status >= 400) throw new Error(\`Drive content verification failed with \${contentObject.status}\`);
  const inlineContent = typeof contentObject.data === "string" ? Buffer.from(contentObject.data, "utf8") : null;
  const binaryData = contentObject.binary_data ? object(contentObject.binary_data, "proxy binary data") : null;
  const binaryUrl = binaryData && typeof binaryData.url === "string" ? binaryData.url : null;
  let providerBytes = inlineContent;
  if (!providerBytes && binaryUrl) {
    const providerResponse = await fetch(binaryUrl);
    if (!providerResponse.ok) throw new Error(\`Drive content download failed with \${providerResponse.status}\`);
    providerBytes = Buffer.from(await providerResponse.arrayBuffer());
  }
  if (!providerBytes) throw new Error("Drive content verification returned neither inline text nor a binary download URL");
  const providerDigest = createHash("sha256").update(providerBytes).digest("hex");
  if (providerDigest !== digest) throw new Error("Drive content hash does not match the verified local report");
  console.log(JSON.stringify({ workflow: workflow.id, sessionId, driveFileId, reportSha256: digest }));
} finally {
  const cleanupFailures: string[] = [];
  for (const relativePath of ownedPaths.reverse()) {
    try { await client.toolRouter.session.files.delete("files", { session_id: sessionId, mount_relative_path: relativePath }); }
    catch { cleanupFailures.push(\`mount path \${relativePath}\`); }
  }
  try { await client.toolRouter.session.delete(sessionId, { maxRetries: 0 }); }
  catch { cleanupFailures.push(\`session \${sessionId}\`); }
  if (cleanupFailures.length) {
    process.exitCode = 1;
    console.error(\`Cleanup incomplete: \${cleanupFailures.join(", ")}\`);
  }
}
`;

/** Rejects exports containing credentials, signed URL secrets, or missing standalone files. */
export function assertExportBundleSafe(bundle: ExportBundle): void {
  for (const filename of REQUIRED_EXPORT_FILES) {
    if (!Object.hasOwn(bundle.files, filename) || !bundle.files[filename]) throw new Error(`Export bundle missing required file: ${filename}`);
  }
  for (const [filename, content] of Object.entries(bundle.files)) {
    if (SECRET_ASSIGNMENT.test(content) || CREDENTIAL_BEARING_URL.test(content) || PRIVATE_KEY.test(content)) throw new Error(`Export bundle contains credential-bearing content in ${filename}`);
  }
}

/** Creates the fixed CSV-to-Drive project without old sessions, signed URLs, or recorder dependencies. */
export function createExportBundle(run: RunRecord): ExportBundle {
  if (run.status !== "verified" || !run.summary) throw new Error("Only verified runs can be exported");
  const manifest: ExportBundle["manifest"] = {
    version: 1,
    sourceRunId: run.runId,
    workflow: "csv-report-to-google-drive",
    inputSlots: ["csvFile", "userId", "folderId"],
    bindings: {
      workbenchInput: "inputs.csvFile",
      reportUpload: "steps.generateReport.output.reportFile",
      providerVerification: "steps.publish.output.fileId",
    },
  };
  const workflowSource = `export const workflow = ${JSON.stringify({ schemaVersion: 1, id: manifest.workflow, inputSlots: manifest.inputSlots, bindings: manifest.bindings }, null, 2)} as const;\n`;
  const packageSource = {
    name: "composio-replay-export",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { start: "tsx src/runner.ts", build: "tsc -p tsconfig.json --noEmit" },
    dependencies: { "@composio/client": "2.0.0-rc.7" },
    devDependencies: { "@types/node": "^24.3.0", tsx: "^4.20.5", typescript: "^5.9.2" },
  };
  const bundle: ExportBundle = {
    filename: `composio-replay-${run.runId}.json`,
    manifest,
    files: {
      "src/workflow.ts": workflowSource,
      "src/runner.ts": STANDALONE_RUNNER,
      "report.py": REPORT_TEMPLATE,
      "package.json": `${JSON.stringify(packageSource, null, 2)}\n`,
      "package-lock.json": createExportPackageLock(),
      "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true }, include: ["src/**/*.ts"] }, null, 2)}\n`,
      ".env.example": "COMPOSIO_API_KEY=\n",
      "input.example.json": `${JSON.stringify({ userId: "replace-with-user-id", folderId: "replace-with-drive-folder-id" }, null, 2)}\n`,
      ".gitignore": "node_modules/\n.env\n",
      "README.md": "# Exported Composio CSV workflow\n\nCopy `.env.example` to `.env`, provide `COMPOSIO_API_KEY`, run `npm install`, then execute `npm start -- input.csv input.json`. Each invocation creates a fresh session, regenerates signed URLs, publishes one report, verifies it through Drive, and cleans up owned mount files.\n",
    },
  };
  assertExportBundleSafe(bundle);
  return bundle;
}
