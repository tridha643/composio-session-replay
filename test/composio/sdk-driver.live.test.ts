import assert from "node:assert/strict";
import { test } from "node:test";

import { createLiveSdkComposioDriverFromEnv } from "../../src/composio/sdk-driver.js";

const REQUIRED_LIVE_ENVIRONMENT = [
  "COMPOSIO_RUN_LIVE_TESTS",
  "COMPOSIO_LIVE_EXECUTION",
  "COMPOSIO_API_KEY",
  "COMPOSIO_TEST_USER_ID",
  "COMPOSIO_TEST_FOLDER_ID",
] as const;

const missingEnvironment = REQUIRED_LIVE_ENVIRONMENT.filter((name) => !process.env[name]);
const liveEnabled = missingEnvironment.length === 0
  && process.env.COMPOSIO_RUN_LIVE_TESTS === "1"
  && process.env.COMPOSIO_LIVE_EXECUTION === "1";

test("live SDK workflow covers the assigned Composio contract", {
  skip: liveEnabled ? false : `requires explicit live gates and environment names: ${REQUIRED_LIVE_ENVIRONMENT.join(", ")}`,
}, async () => {
  const userId = process.env.COMPOSIO_TEST_USER_ID;
  const folderId = process.env.COMPOSIO_TEST_FOLDER_ID;
  assert.ok(userId && folderId);

  const result = await createLiveSdkComposioDriverFromEnv(process.env).execute({
    csvName: "sdk-driver-live-contract.csv",
    csvContent: "category,amount\nLive,1.25\nLive,2.75\n",
    folderId,
    userId,
  });

  assert.equal(result.summary.grandTotal, "4.00");
  assert.equal(result.summary.inputRows, 2);
  assert.ok(result.artifacts.some((artifact) => artifact.kind === "published" && artifact.value));
  assert.equal(JSON.stringify(result.events).includes(process.env.COMPOSIO_API_KEY!), false);
});
