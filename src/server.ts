import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FakeComposioDriver } from "./composio/fake-driver.js";
import { createLiveSdkComposioDriverFromEnv } from "./composio/sdk-driver.js";
import { ReplayService } from "./domain/service.js";
import { JsonRunStore } from "./domain/store.js";
import type { RunInput, WorkflowDriver } from "./domain/types.js";

export interface ReplayServerOptions {
  port?: number;
  host?: string;
  driver?: "fake" | "live" | WorkflowDriver;
  dataDirectory?: string;
  publicDirectory?: string;
}

export interface RunningReplayServer {
  origin: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("Request body exceeds the 2 MiB limit");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function runInput(body: Record<string, unknown>): RunInput {
  for (const key of ["csvName", "csvContent", "folderId", "userId"] as const) {
    if (typeof body[key] !== "string") throw new Error(`${key} must be a string`);
  }
  return { csvName: body.csvName as string, csvContent: body.csvContent as string, folderId: body.folderId as string, userId: body.userId as string };
}

async function serveStatic(response: ServerResponse, pathname: string, publicDirectory: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(publicDirectory, relative);
  if (!resolved.startsWith(`${path.resolve(publicDirectory)}${path.sep}`)) { sendJson(response, 404, { error: "Not found" }); return; }
  try {
    const content = await readFile(resolved);
    const extension = path.extname(resolved);
    const contentTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
    };
    response.writeHead(200, {
      "content-type": contentTypes[extension] ?? "application/octet-stream",
      "cache-control": extension === ".svg" || extension === ".png" || extension === ".woff2" ? "public, max-age=3600" : "no-cache",
    });
    response.end(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") sendJson(response, 404, { error: "Not found" });
    else throw error;
  }
}

export async function createReplayServer(options: ReplayServerOptions = {}): Promise<RunningReplayServer> {
  const driver = options.driver === undefined || options.driver === "fake"
    ? new FakeComposioDriver()
    : options.driver === "live"
      ? createLiveSdkComposioDriverFromEnv()
      : options.driver;
  const service = new ReplayService(new JsonRunStore(options.dataDirectory ?? ".replay-data/runs"), driver);
  const publicDirectory = options.publicDirectory ?? path.resolve("public");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, mode: driver.mode });
        return;
      }
      if (method === "GET" && url.pathname === "/api/sessions") {
        const filters: { query?: string; status?: string } = {};
        const query = url.searchParams.get("query");
        const status = url.searchParams.get("status");
        if (query) filters.query = query;
        if (status) filters.status = status;
        sendJson(response, 200, await service.list(filters));
        return;
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (method === "GET" && sessionMatch) {
        sendJson(response, 200, await service.requireRun(decodeURIComponent(sessionMatch[1]!)));
        return;
      }
      if (method === "POST" && url.pathname === "/api/runs") {
        sendJson(response, 201, await service.start(runInput(await readJson(request))));
        return;
      }
      const replayMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/replay$/);
      if (method === "POST" && replayMatch) {
        const body = await readJson(request);
        if (typeof body.csvName !== "string" || typeof body.csvContent !== "string") throw new Error("csvName and csvContent must be strings");
        const replacement: Pick<RunInput, "csvName" | "csvContent"> & Partial<Pick<RunInput, "folderId" | "userId">> = { csvName: body.csvName, csvContent: body.csvContent };
        if (typeof body.folderId === "string") replacement.folderId = body.folderId;
        if (typeof body.userId === "string") replacement.userId = body.userId;
        sendJson(response, 201, await service.replay(decodeURIComponent(replayMatch[1]!), replacement));
        return;
      }
      const compareMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/compare\/([^/]+)$/);
      if (method === "GET" && compareMatch) {
        sendJson(response, 200, await service.compare(decodeURIComponent(compareMatch[1]!), decodeURIComponent(compareMatch[2]!)));
        return;
      }
      const exportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/export$/);
      if (method === "POST" && exportMatch) {
        sendJson(response, 200, await service.export(decodeURIComponent(exportMatch[1]!)));
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        await serveStatic(response, url.pathname, publicDirectory);
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.startsWith("Run not found") ? 404 : 400, { error: message });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 4317, options.host ?? "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Replay server did not bind to a TCP port");
  return { origin: `http://${options.host ?? "127.0.0.1"}:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  const running = await createReplayServer({ port: Number(process.env.PORT ?? 4317), driver: process.env.REPLAY_DRIVER === "live" ? "live" : "fake" });
  console.log(`Composio replay running at ${running.origin}`);
}
