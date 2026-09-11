# Composio file workflow recording, replay, and export

Status: implementation scope, researched September 11, 2026. No application has been built or live workflow executed in this task.

## Problem and outcome

A successful Composio workflow contains tool calls, file transfers, temporary URLs, session state, and dependencies between outputs and later inputs. Copying its requests does not produce a workflow another developer can run independently.

Build a local app that records a supported file workflow, makes its inputs and dependencies explicit, replays it in a fresh session, and exports a standalone TypeScript project. Initial users are developers, support engineers, and FDEs handing off working examples. The customer request for a playground [view-code/fork affordance](https://composioworkspace.slack.com/archives/C0AK054L1T6/p1789105343021439) supports the handoff problem; the recorder design is our proposed solution, not an already validated customer specification.

Success: record with CSV A, replay with CSV B, export and run with CSV C from a clean directory. Each produces the correct report in the selected Google Drive folder, verified by reading the destination. The original session and its temporary URLs are unnecessary. All 12 assigned SDK methods have evidence-backed outcomes.

## First complete workflow

Use a small synthetic CSV with required columns `category,amount`. The fixed report template returns per-category row counts and exact decimal totals in a sorted CSV. V1 accepts UTF-8 CSVs up to an application-chosen 1 MiB limit; this is a scope limit, not a claimed API limit. No Google Sheets conversion.

1. **Connect and preflight.** Configure the project key on the server, a user ID, and an existing test folder. Create a workbench-enabled session; call toolkits, tools, search, and `session.link`. If OAuth is incomplete, show the returned link and wait for completion. Once linked, use the account ID returned by `session.link` within that fresh session and confirm it is active through `session.toolkits`. Preflight the destination folder via a proxy read before any provider write. Check the report upload tool and required schemas are available.
2. **Stage the input.** Call `session.files.createUploadURL('files', {session_id, mount_relative_path, mimetype})`, PUT the actual file bytes to the returned URL, then list and download the staged input to verify its bytes. Use a new run-relative path. Record the PUT/GET as first-class transfer steps: SDK calls alone omit these side effects.
3. **Generate the report.** Call `session.executeMeta` with `COMPOSIO_REMOTE_WORKBENCH`. Execute a reviewed, self-contained CSV template using Python standard-library CSV and Decimal support. It reads only this run's input and writes this run's report beneath the returned sandbox mount prefix. Upload a JSON parameters file instead of interpolating user values into executable Python. Every replay executes the complete template, without relying on previous interpreter variables or arbitrary installed packages.
4. **Read the output.** Use `files.list` and `files.createDownloadURL`, fetch the report bytes, and validate the report's schema and expected aggregates. A file URL or HTTP 200 alone is insufficient. Downloaded evidence and output survive cleanup in the local run directory.
5. **Publish with a native tool call.** Call `session.execute` for `GOOGLEDRIVE_UPLOAD_FROM_URL`, passing a freshly obtained report URL, `name`, `parent_folder_id`, and `mime_type: text/csv`. Resolve the returned Drive file ID from the actual validated response. The older `GOOGLEDRIVE_UPLOAD_FILE` schema requires a FileUploadable containing `name`, `mimetype`, and `s3key`; do not pass a signed URL into that object or assume core's automatic upload behavior exists in the raw client.
6. **Verify through the proxy path.** Use `session.proxyExecute` to GET the returned Drive file's metadata and content. Check parent folder, MIME type, size, and byte hash against the locally verified report. Follow `binary_data.url` when proxy output supplies a binary download reference; treat that URL as ephemeral. Google Drive's [files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get) supports metadata and `alt=media` for stored files. The wire shape of Composio's proxy result must be proven during the first live slice.
7. **Clean up transient storage.** Explicitly delete this run's mount files, check their absence, then delete the session and verify it can no longer be retrieved. Do not infer file deletion from session deletion. Keep the published report as the useful output; an explicit test-cleanup option can remove only the exact Drive file created by that run. Report leftover resources if cleanup fails.

## Exact assigned coverage

All names below are under `toolRouter`. These are planned checks, not completed results.

| # | Method | Purpose and required evidence |
|---|---|---|
| 1 | `session.toolkits` | Show connection readiness; verify selected Google Drive account is usable. |
| 2 | `session.tools` | Show tools exposed by this session; distinguish meta tools from native tools discovered through search. |
| 3 | `session.search` | Discover the supported upload operation; record the selected slug and schema without letting later search reorder or replace workflow steps. |
| 4 | `session.link` | Exercise actual test-account connection; verify completion, not merely URL creation. Replays need not reconnect an already valid account. |
| 5 | `session.files.createUploadURL` | Obtain a URL and perform the PUT; verify staged bytes. |
| 6 | `session.files.list` | Locate only this run's files; exercise pagination and exact-path matching. |
| 7 | `session.executeMeta` | Run the CSV report template; check both the response envelope and actual output artifact. |
| 8 | `session.files.createDownloadURL` | Fetch and validate actual bytes; obtain a new URL for each replay. |
| 9 | `session.execute` | Upload the verified report through the selected Google Drive tool; retain the returned resource ID. |
| 10 | `session.proxyExecute` | Check folder readiness, then verify the uploaded file's metadata and content. |
| 11 | `session.files.delete` | Delete only owned mount paths and verify disappearance; missing-file deletion may itself succeed. |
| 12 | `session.delete` | Delete the owned session; retrieve afterward must reject it. A repeated delete is expected to return not found. |

Session create/retrieve and direct signed-URL PUT/GET are necessary supporting operations outside the assigned 12. Coverage is counted by SDK method, not by number of calls. Record method, redacted request, response/error, verification evidence, reproduction, and Pass/API defect/Client defect. A blocked endpoint stays honestly blocked and is handed off; it is never relabeled as a defect just to fill the table.

## Recorder and replay contract

Record calls made through this app's execution adapter. Capture the semantic SDK operation before HTTP dispatch; the client's transport hook can observe multiple retry attempts and is not the authoritative workflow recorder. Record SDK/client errors, tool-level errors, and provider HTTP statuses separately.

| Data | Owner and behavior |
|---|---|
| Workflow definition | App-authored, versioned manifest: ordered supported operations, input schema, bindings, report template, assertions, explicit writes, cleanup. Both replay and export consume it. |
| Original run | Append-only events and artifact metadata under a local run ID. Preserve original outcome when creating a replay. Never use the old run as mutable runtime state. |
| Input bindings | Explicit references to user inputs, earlier step output paths, and current-run session/artifact values. No inference by string equality and no evaluating user-written expressions. Reject missing or forward references before writes. |
| Artifact reference | Logical artifact ID, mount ID, relative path, MIME type, size, and digest. Signed URLs remain short-lived runtime values, not manifest literals. |
| Connection choice | Explicit user/account configuration, resolved anew for the current project and user. Credentials remain server-side; account identity is not inferred from a previous customer run. |
| Run state | Server writes a durable started event before dispatch and a terminal result afterward. An interrupted in-flight step becomes unknown on restart; the app does not resume it automatically. |
| Export | Workflow manifest, identical runner source, report template, assertions, and placeholder configuration. No app server, old session, LLM, recording database, or hosted recorder service is required. |

V1 step families: file upload/download, native execute, allowlisted meta execute, allowlisted proxy execute, assertions, and owned-resource cleanup. Discovery and linking are setup events, not a mandate to redo OAuth or dynamically select different tools on every replay.

V1 meta support is deliberately bounded: the complete report template and read-only schema lookup if needed. Arbitrary bash/Python, nested multi-execute, custom tools, and opaque helper side effects are recorded as unsupported if encountered and prevent a runnable export. Supporting the `executeMeta` endpoint does not mean supporting every meta-tool program.

## UX: three compact views

1. **Run:** choose the input CSV, selected account, and folder; preview the destination write; run and see the resulting report.
2. **Inspect/replay:** ordered call timeline with status and sanitized argument/result previews; inspect bindings, choose a new CSV or folder, and replay. Distinguish verified success, call failure, unknown outcome, unsupported step, and cleanup failure. File bytes stay in a separate artifact panel.
3. **Export:** show required configuration and supported-step checks, then download the project. The normal UI describes the task; raw SDK details are available for inspection rather than required to understand the flow.

One active run per local app instance. Bind the server to loopback, validate write requests against the local UI origin, and keep API keys out of the browser. No multi-user service, login system, cloud deployment, or production dashboard modification in this hackathon scope.

## Failure and retry rules

| Situation | Required behavior |
|---|---|
| Missing connection, inaccessible folder, unavailable tool/schema | Stop preflight; explain the exact missing prerequisite. No provider write. |
| Invalid CSV, too large, malformed amounts, missing columns | Reject with row/field detail before publishing. Never silently skip bad rows. |
| File upload succeeds but mount is not readable in workbench | Stop with mount-readiness evidence. Do not interpret missing files as empty input. |
| Expired signed URL | Regenerate for the current artifact when retrying a read or before a new operation. Never reuse a stored URL from the recording. |
| Missing output, tool error inside HTTP 200, proxy `status` failure | Mark failed; do not publish or export the run as verified success. |
| Provider upload timed out, network broke, or app died in-flight | Mark unknown and stop. Never automatically retry the write or claim it failed without reconciling destination state. |
| Multiple matching accounts or changed schema | Require explicit account/binding resolution. No fallback to another account or tool. |
| Cleanup fails | Preserve the useful result and exact leftover resource references locally; offer explicit cleanup. Never claim full cleanup. |
| Export contains a secret, credential-bearing URL, unsupported step, unresolved binding, or old session reference | Reject export with a concrete reason. Export only allowlisted fields; sensitive inputs become configuration placeholders. |

Set client `maxRetries: 0` for execution writes and unknown-effect calls. The inspected client accepts `idempotencyKey` for compatibility but documents that it sends no idempotency header. No exactly-once guarantee. A deliberate new replay is a new run and may create a new report. Read-only retries can be bounded and logged separately from logical workflow steps.

## Implementation shape

Start a new standalone TypeScript app in this workspace. Proposed structure (not existing files):

```
src/server/           local API, environment credentials, run ownership, event stream
src/workflow/         manifest schema, binding validation, export readiness
src/runner/           sequential runner and execution/result adapters
src/recorder/         durable run events and sanitized inspection views
src/artifacts/        byte transfer, local artifacts, digest and owned-path checks
src/export/           project templates and ZIP assembly using the same runner
src/ui/               run form, call timeline, file panel, replay/export controls
templates/csv-report/ reviewed Python template and expected report contract
tests/               contract fixtures, fresh-run replay and export tests
.data/               ignored local runs/artifacts; never included in export
```

Call path: UI → server preflight → manifest validation → runner resolves input bindings → recorder writes start → typed SDK adapter or byte-transfer adapter executes → result adapter checks envelope → verifier checks output → recorder writes completion → UI receives event. Replay creates a new run context and follows the same path. Export copies the runner and validated definition into an independent project.

Important boundaries: `WorkflowDefinition` contains schema version and typed steps; `RunContext` owns session/account/artifact values; `StepResult` distinguishes success/failure/unknown/unsupported; `ArtifactRef` is a logical file descriptor; `Binding` is literal/input/prior-output/current-artifact. Derive SDK adapter inputs from the published client types instead of recreating permissive parallel request types. The UI never calls Composio directly.

Export contents: `workflow.ts`, `runner.ts` (or a small source directory), `report.py`, `package.json`, lockfile, `tsconfig.json`, `.env.example`, input configuration example, and `README.md`. Use `@composio/client@2.0.0-rc.7` as the researched starting pin; verify the hackathon beta before scaffolding and record the exact version actually used. Pin application dependencies at scaffolding. Capture tool versions when exposed; do not claim provider/tool determinism when a version cannot be pinned. Record and check required schema compatibility instead.

## Delivery order and acceptance

| Slice | Deliverable | Acceptance |
|---|---|---|
| 1. Live executable recipe | One script completing connection, mount upload, report generation, Drive publish, verification, and cleanup | Every assigned SDK method has a real result; schema/path/account assumptions are resolved before building the UI. |
| 2. Record and replay | Definition, explicit bindings, event store, common runner | CSV A recording replays with B in a fresh session after the original is deleted. No stale URL/ID or interpreter state is reused. |
| 3. Standalone export | ZIP produced from the same definition/runner | Extract in a clean directory, install from lockfile, configure credentials and CSV C, execute and verify without the app running. |
| 4. Product UI | Run, inspect, replay, export views | A developer can identify inputs, expected writes, real output, and a failing step without reading implementation code. |
| 5. Failure checks and handoff | Coverage report, focused reproductions, four-minute demo | Failure behavior and all 12 endpoint outcomes are reviewable; unknowns and blockers remain visible. |

Core precedes polish: do not spend the remaining hackathon time building a generic node editor, recorder middleware for every SDK, or importing old playground sessions.

## Validation matrix

- A/B/C inputs have distinct expected aggregates; verify against independently written golden fixtures, not merely against the report generator's own output.
- Replayed upload, report path, signed URLs, and Drive file ID belong to the new run. Start once with the original session deleted.
- Proxy-read destination bytes match the verified report and metadata shows the selected folder; wrong-folder and same-name-existing-file fixtures do not pass.
- Binary PUT and GET errors are represented; expired URL refresh, empty content, truncated output, paginated file list, and missing output are covered.
- Meta HTTP 200 with an inner error and proxy HTTP 200 with a failing provider status both fail correctly.
- A transport fault after the destination accepts a write does not trigger a second write. Process restart preserves unknown state and stops execution.
- Missing/ambiguous account and schema drift fail before publishing. Unsupported meta calls cannot silently disappear from the export.
- Export scan and generated-code tests reject API keys, bearer headers, cookies, connection credentials, signed URL query strings, raw private response payloads, and original session IDs. Test quotes/newlines/path characters in user inputs without generating executable injection.
- Mount cleanup precedes session deletion; only resources belonging to that run are eligible. Useful Drive output is retained unless explicit test cleanup is selected.
- Run lint, typecheck, unit/contract tests, and clean-export integration tests; define the exact package scripts while scaffolding. Mock checks are not evidence of live endpoint success.

## Research receipts and remaining live gates

- [Hackathon assignment](https://composioworkspace.slack.com/archives/C0C1L1E0X40/p1789153911418789): 12 methods assigned to Tri; read live through Composio CLI.
- [Customer handoff request](https://composioworkspace.slack.com/archives/C0AK054L1T6/p1789105343021439): view-code/fork request, not confirmation that a replay product is already specified.
- Current client main inspected at `6c30ca8d24c6041295dedac2128344583dee420f`; [OpenAPI contract](https://github.com/ComposioHQ/composio-client/blob/6c30ca8d24c6041295dedac2128344583dee420f/spec/openapi.json) and published `2.0.0-rc.7` type declarations agree on mountID-first file methods with `session_id` in params, meta-tool slugs, proxy binary outputs, and separate transfer requests. The source README's operation count differs from the brief, so coverage is anchored to the explicit 12-method assignment.
- [Client request options](https://github.com/ComposioHQ/composio-client/tree/6c30ca8d24c6041295dedac2128344583dee420f/src): inspected packed types document no idempotency header. The plan disables automatic execution retries accordingly.
- Platform local checkout inspected at `fba1138b46c680de99f91aff876d3c91853c88fa`: `apps/apollo/src/lib/toolRouterV2/features/workbench/storage_credentials/mounts.ts` scopes the files mount by org/project/user/session. `features/session/delete.ts` tombstones the session and schedules compute teardown; it is not evidence of object-storage deletion.
- `docs/tool-router-file-handling-demo.md` already describes CSV → workbench → files-panel behavior. Its examples use an older `path` request field; the current request contract uses `mount_relative_path`. Reuse the concept, not stale request bodies.
- Live Composio tool definitions distinguish `GOOGLEDRIVE_UPLOAD_FROM_URL` (`source_url`, `name`, optional `parent_folder_id`) from `GOOGLEDRIVE_UPLOAD_FILE` (FileUploadable). Select the former and verify its exact response shape in slice 1.
- [Google Drive files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get) confirms metadata and content retrieval; text/csv avoids Workspace-document export conversion.
- Nia's existing `ComposioHQ/composio:next` index is older than today's client. A new private client index was attempted but rejected because Nia lacks the required GitHub App installation. Use Nia examples only as context, and current packed types/source as the contract authority.
- Nia search receipt `e087f743-cd31-4826-9398-ddca1c64837b` found upload/download snippets and workbench configuration examples, but those snippets do not establish the exact upload response field containing the new Drive ID. That extraction remains a live contract check; do not invent `data.id` or `file_id` as a universal response path. The older core examples' local-path convenience is also not the generated client's wire contract.
- Current dashboard main has a semantic tool execution boundary in `src/app/api/playground/route.ts`; inspected at `dacd8c358d7e4395eead7c26e0f67812b2108969`. It is a possible later integration point. No dashboard changes are in this scope.

Unproven until slice 1: this project's usable test credentials/scopes, workbench mount readiness, Drive URL-upload availability in a fresh session, exact native/meta/proxy success envelopes, and independent exported authentication. These are live feasibility gates, not reasons to claim a completed replay. If an API defect blocks one, retain its reproduction and coverage status rather than substituting an unrelated endpoint without saying so.
