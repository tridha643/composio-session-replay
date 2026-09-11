# Composio Session Replay

This prototype records a CSV-to-Google-Drive workflow as a redacted timeline, replays it in a fresh Composio session with replacement input, compares verified outputs, and exports the workflow as a standalone TypeScript project.

## Run it

```sh
npm install
npm run check
npm run dev
```

Open `http://localhost:4317`. The default driver is deterministic simulation mode: it exercises the complete file and session workflow locally and never creates a provider file.

To enable the real Composio driver, provide the Composio developer project's API key. The driver resolves the run user's active Drive connection from the session and calls `session.link()` when setup is required, so callers don't pass a connected-account ID:

```sh
COMPOSIO_LIVE_EXECUTION=1 \
COMPOSIO_API_KEY=... \
REPLAY_DRIVER=live \
npm run dev
```

Each live run also requires a user ID and a destination Google Drive folder ID in the UI. Write calls use zero automatic retries, every provider result is verified, signed URLs and credentials are redacted, and run-owned mount files and the session are deleted at the end.

## Covered workflow

The driver covers `session.create`, `retrieve`, `toolkits`, `tools`, `search`, `link`, `executeMeta`, `execute`, `proxyExecute`, `delete`, and the four session file methods: `list`, `createUploadURL`, `createDownloadURL`, and `delete`. The signed URL byte transfers are recorded as separate events because they happen outside the SDK client.

The live contract test is deliberately gated because it writes one report to Google Drive:

```sh
COMPOSIO_RUN_LIVE_TESTS=1 \
COMPOSIO_LIVE_EXECUTION=1 \
COMPOSIO_API_KEY=... \
COMPOSIO_TEST_USER_ID=... \
COMPOSIO_TEST_FOLDER_ID=... \
npm test
```
