import assert from "node:assert/strict";
import { test } from "node:test";

import { ASSIGNED_OPERATIONS } from "../../src/domain/types.js";
import {
  SdkComposioDriver,
  SdkDriverError,
  createLiveSdkComposioDriverFromEnv,
  type SdkDriverClient,
} from "../../src/composio/sdk-driver.js";

interface RecordedCall {
  name: string;
  args: unknown[];
}

interface MockFailureOptions {
  createError?: Error;
  folderStatus?: number;
  metaToolError?: string;
  putStatus?: number;
}

interface MockHarness {
  calls: RecordedCall[];
  client: SdkDriverClient;
  fetch: typeof globalThis.fetch;
}

const SESSION_ID = "trs_contract_session";
const ACCOUNT_ID = "ca_google_drive_test";
const FOLDER_ID = "drive-folder-test";
const DRIVE_FILE_ID = "drive-report-id";
const INPUT_CSV = "category,amount\nNorth,10.25\nSouth,2.00\nNorth,1.75\n";
const REPORT_CSV = "category,row_count,total\nNorth,2,12.00\nSouth,1,2.00\n";

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function makeMockHarness(failures: MockFailureOptions = {}): MockHarness {
  const calls: RecordedCall[] = [];
  const mountedFiles = new Map<string, Buffer>();
  const uploadTargets = new Map<string, string>();
  const downloadTargets = new Map<string, Buffer>();
  let uploadSequence = 0;
  let downloadSequence = 0;
  let sessionDeleted = false;
  let linkCalled = false;
  let publishedBytes: Buffer = Buffer.alloc(0);

  function called(name: string, args: unknown[]): void {
    calls.push({ name, args });
  }

  const session = {
    async create(...args: unknown[]) {
      called("session.create", args);
      if (failures.createError) throw failures.createError;
      return { session_id: SESSION_ID, config: {}, mcp: { type: "http", url: "https://mcp.example.test?token=signed-secret" }, tool_router_tools: [] };
    },
    async retrieve(...args: unknown[]) {
      called("session.retrieve", args);
      if (sessionDeleted) throw Object.assign(new Error("not found"), { status: 404 });
      return { session_id: SESSION_ID, config: {}, mcp: { type: "http", url: "https://mcp.example.test?token=signed-secret" }, tool_router_tools: [] };
    },
    async delete(...args: unknown[]) {
      called("session.delete", args);
      sessionDeleted = true;
      return { session_id: SESSION_ID, deleted: true };
    },
    async toolkits(...args: unknown[]) {
      called("session.toolkits", args);
      return {
        items: [{
          name: "Google Drive",
          slug: "googledrive",
          enabled: true,
          is_no_auth: false,
          composio_managed_auth_schemes: ["OAUTH2"],
          meta: { logo: "", description: "", isNoAuth: false },
          connected_account: linkCalled ? {
            id: ACCOUNT_ID,
            user_id: "contract-user",
            status: "ACTIVE",
            created_at: "2026-09-11T00:00:00.000Z",
            auth_config: { id: "auth-config", auth_scheme: "OAUTH2", is_composio_managed: true },
          } : null,
        }],
        total_pages: 1,
        current_page: 1,
        total_items: 1,
      };
    },
    async tools(...args: unknown[]) {
      called("session.tools", args);
      return { items: [{ slug: "COMPOSIO_REMOTE_WORKBENCH" }], total_pages: 1, current_page: 1, total_items: 1 };
    },
    async search(...args: unknown[]) {
      called("session.search", args);
      return {
        success: true,
        error: null,
        results: [{ index: 1, use_case: "upload", primary_tool_slugs: ["GOOGLEDRIVE_UPLOAD_FROM_URL"], related_tool_slugs: [], toolkits: ["googledrive"] }],
        tool_schemas: { GOOGLEDRIVE_UPLOAD_FROM_URL: { input_parameters: { type: "object" } } },
      };
    },
    async link(...args: unknown[]) {
      called("session.link", args);
      linkCalled = true;
      return {
        link_token: "link-secret",
        redirect_url: "https://auth.example.test/connect?token=link-secret",
        connected_account_id: ACCOUNT_ID,
      };
    },
    async executeMeta(...args: unknown[]) {
      called("session.executeMeta", args);
      if (failures.metaToolError) {
        return { data: { successful: false, error: failures.metaToolError }, error: null, log_id: "meta-log" };
      }
      const parametersEntry = [...mountedFiles.entries()].find(([path]) => path.endsWith("/parameters.json"));
      assert.ok(parametersEntry);
      const parameters = JSON.parse(parametersEntry[1].toString("utf8")) as { output_path: string };
      const relativeOutputPath = parameters.output_path.replace(/^\/mnt\/files\//, "");
      mountedFiles.set(relativeOutputPath, Buffer.from(REPORT_CSV));
      return { data: { successful: true, output_path: parameters.output_path }, error: null, log_id: "meta-log" };
    },
    async execute(...args: unknown[]) {
      called("session.execute", args);
      const body = record(args[1]);
      const toolArguments = record(body.arguments);
      assert.equal(Object.hasOwn(body, "account"), false);
      assert.equal(toolArguments.parent_folder_id, FOLDER_ID);
      const sourceURL = toolArguments.source_url;
      if (typeof sourceURL !== "string") throw new Error("mock expected a source_url string");
      publishedBytes = downloadTargets.get(sourceURL) ?? Buffer.alloc(0);
      return { data: { id: DRIVE_FILE_ID }, error: null, log_id: "execute-log" };
    },
    async proxyExecute(...args: unknown[]) {
      called("session.proxyExecute", args);
      const body = record(args[1]);
      const endpoint = String(body.endpoint);
      const parameters = Array.isArray(body.parameters) ? body.parameters : [];
      const isMedia = parameters.some((parameter) => record(parameter).value === "media");
      if (endpoint.endsWith(`/${FOLDER_ID}`)) {
        return {
          status: failures.folderStatus ?? 200,
          data: { id: FOLDER_ID, mimeType: "application/vnd.google-apps.folder", trashed: false },
        };
      }
      if (isMedia) {
        const url = "https://provider-download.example.test/report?signature=signed-secret";
        downloadTargets.set(url, publishedBytes);
        return { status: 200, binary_data: { url, content_type: "text/csv", size: publishedBytes.byteLength } };
      }
      return {
        status: 200,
        data: { id: DRIVE_FILE_ID, name: "input-summary.csv", parents: [FOLDER_ID], mimeType: "text/csv", size: String(publishedBytes.byteLength), trashed: false },
      };
    },
    files: {
      async createUploadURL(...args: unknown[]) {
        called("session.files.createUploadURL", args);
        const params = record(args[1]);
        const path = String(params.mount_relative_path);
        const url = `https://upload.example.test/${uploadSequence += 1}?token=signed-secret`;
        uploadTargets.set(url, path);
        return { upload_url: url, mount_relative_path: path, sandbox_mount_prefix: "/mnt/files", expires_at: "2026-09-11T01:00:00.000Z" };
      },
      async createDownloadURL(...args: unknown[]) {
        called("session.files.createDownloadURL", args);
        const params = record(args[1]);
        const path = String(params.mount_relative_path);
        const url = `https://download.example.test/${downloadSequence += 1}?signature=signed-secret`;
        const bytes = mountedFiles.get(path);
        assert.ok(bytes, `missing mocked mount file ${path}`);
        downloadTargets.set(url, bytes);
        return { download_url: url, mount_relative_path: path, sandbox_mount_prefix: "/mnt/files", expires_at: "2026-09-11T01:00:00.000Z" };
      },
      async list(...args: unknown[]) {
        called("session.files.list", args);
        const params = record(args[1]);
        const prefix = String(params.mount_relative_prefix);
        const entries = [...mountedFiles.entries()].filter(([path]) => path.startsWith(prefix)).sort(([left], [right]) => left.localeCompare(right));
        const index = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const entry = entries[index];
        return {
          items: entry ? [{ mount_relative_path: entry[0], sandbox_mount_prefix: "/mnt/files", size: entry[1].byteLength, last_modified: "2026-09-11T00:00:00.000Z" }] : [],
          ...(index + 1 < entries.length ? { next_cursor: String(index + 1) } : {}),
        };
      },
      async delete(...args: unknown[]) {
        called("session.files.delete", args);
        const params = record(args[1]);
        const path = String(params.mount_relative_path);
        mountedFiles.delete(path);
        return { mount_relative_path: path, sandbox_mount_prefix: "/mnt/files" };
      },
    },
  };

  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const path = uploadTargets.get(url);
      assert.ok(path, `unexpected upload URL ${url}`);
      const body = init?.body;
      assert.ok(body instanceof ArrayBuffer);
      mountedFiles.set(path, Buffer.from(body));
      const status = failures.putStatus ?? 200;
      return new Response(null, { status });
    }
    const bytes = downloadTargets.get(url);
    assert.ok(bytes, `unexpected download URL ${url}`);
    return new Response(Uint8Array.from(bytes).buffer, { status: 200, headers: { "content-type": "text/csv" } });
  };

  return { calls, client: { toolRouter: { session } } as unknown as SdkDriverClient, fetch: fetchImplementation };
}

function makeDriver(harness: MockHarness): SdkComposioDriver {
  return new SdkComposioDriver({
    client: harness.client,
    allowLiveExecution: true,
    fetch: harness.fetch,
  });
}

function runInput() {
  return { csvName: "input.csv", csvContent: INPUT_CSV, folderId: FOLDER_ID, userId: "contract-user" };
}

test("executes all assigned SDK methods, transfers bytes, preserves envelopes, and redacts temporary credentials", async () => {
  const harness = makeMockHarness();
  const result = await makeDriver(harness).execute(runInput());

  assert.equal(result.composioSessionId, SESSION_ID);
  assert.equal(result.summary.grandTotal, "14.00");
  assert.equal(result.summary.inputRows, 3);
  assert.deepEqual(result.summary.categories, [
    { category: "North", rowCount: 2, total: "12.00" },
    { category: "South", rowCount: 1, total: "2.00" },
  ]);
  for (const operation of ASSIGNED_OPERATIONS) {
    assert.ok(result.events.some((event) => event.operation === operation && event.status === "success"), `missing ${operation}`);
  }
  assert.ok(result.events.some((event) => event.operation === "session.create" && event.status === "success"));
  assert.ok(result.events.some((event) => event.operation === "session.retrieve" && event.status === "success"));
  assert.ok(result.events.some((event) => event.operation === "signed-url.put" && event.status === "success"));
  assert.ok(result.events.some((event) => event.operation === "signed-url.get" && event.status === "success"));

  const executeEvent = result.events.find((event) => event.operation === "session.execute");
  assert.ok(executeEvent && executeEvent.status === "success");
  assert.equal(record(record(executeEvent.output).data).id, DRIVE_FILE_ID);
  const serializedEvents = JSON.stringify(result.events);
  assert.equal(serializedEvents.includes("signed-secret"), false);
  assert.equal(serializedEvents.includes("link-secret"), false);
  assert.match(serializedEvents, /redacted/i);

  const paginatedList = harness.calls.find((call) => call.name === "session.files.list" && record(call.args[1]).cursor === "1");
  assert.ok(paginatedList, "file listing should follow next_cursor");
});

test("uses session.link without requiring a connected account input", async () => {
  const harness = makeMockHarness();
  await makeDriver(harness).execute(runInput());

  const create = harness.calls.find((call) => call.name === "session.create");
  assert.ok(create);
  assert.equal(Object.hasOwn(record(create.args[0]), "connected_accounts"), false);
  const execute = harness.calls.find((call) => call.name === "session.execute");
  assert.ok(execute);
  assert.equal(Object.hasOwn(record(execute.args[1]), "account"), false);
});

test("sets maxRetries 0 on every write and unknown-effect SDK request", async () => {
  const harness = makeMockHarness();
  await makeDriver(harness).execute(runInput());

  const writes = new Set([
    "session.create",
    "session.link",
    "session.files.createUploadURL",
    "session.files.createDownloadURL",
    "session.executeMeta",
    "session.execute",
    "session.files.delete",
    "session.delete",
  ]);
  for (const call of harness.calls.filter((candidate) => writes.has(candidate.name))) {
    const options = record(call.args.at(-1));
    assert.equal(options.maxRetries, 0, `${call.name} must disable automatic retries`);
  }
});

test("classifies SDK, tool, provider, and transfer failures without leaking signed URLs", async (context) => {
  const cases: Array<{ name: string; failures: MockFailureOptions; category: SdkDriverError["category"]; operation: SdkDriverError["operation"] }> = [
    { name: "SDK transport", failures: { createError: new TypeError("network failed at https://api.example.test?api_key=secret") }, category: "sdk", operation: "session.create" },
    { name: "tool envelope", failures: { metaToolError: "python execution failed" }, category: "tool", operation: "session.executeMeta" },
    { name: "provider status", failures: { folderStatus: 403 }, category: "provider", operation: "session.proxyExecute" },
    { name: "signed URL transfer", failures: { putStatus: 503 }, category: "transfer", operation: "signed-url.put" },
  ];

  for (const failureCase of cases) {
    await context.test(failureCase.name, async () => {
      const harness = makeMockHarness(failureCase.failures);
      await assert.rejects(
        () => makeDriver(harness).execute(runInput()),
        (error: unknown) => {
          assert.ok(error instanceof SdkDriverError);
          assert.equal(error.category, failureCase.category);
          assert.equal(error.operation, failureCase.operation);
          const failedEvent = [...error.events].reverse().find((event) => event.operation === failureCase.operation && event.status !== "success");
          assert.ok(failedEvent);
          if (failedEvent.status === "error" || failedEvent.status === "unknown") assert.equal(failedEvent.error.category, failureCase.category);
          const serialized = JSON.stringify(error.events);
          assert.equal(serialized.includes("api_key=secret"), false);
          assert.equal(serialized.includes("signed-secret"), false);
          return true;
        },
      );
    });
  }
});

test("requires an explicit live gate before constructing a real driver", () => {
  const harness = makeMockHarness();
  assert.throws(() => new SdkComposioDriver({
    client: harness.client,
    allowLiveExecution: false,
    fetch: harness.fetch,
  }), /execution is disabled/i);
  assert.throws(() => createLiveSdkComposioDriverFromEnv({}), /COMPOSIO_LIVE_EXECUTION=1/);
  assert.throws(
    () => createLiveSdkComposioDriverFromEnv({ COMPOSIO_LIVE_EXECUTION: "1" }),
    /COMPOSIO_API_KEY/,
  );
});

test("rejects unsafe input before any remote write", async () => {
  const harness = makeMockHarness();
  await assert.rejects(
    () => makeDriver(harness).execute({ ...runInput(), csvName: "../input.csv" }),
    (error: unknown) => error instanceof SdkDriverError && error.category === "validation",
  );
  assert.equal(harness.calls.length, 0);
});
