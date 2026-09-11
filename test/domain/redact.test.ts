import assert from "node:assert/strict";
import { test } from "node:test";

import { redact } from "../../src/domain/redact.js";

test("redact removes nested credentials and signed URL query strings", () => {
  const result = redact({
    apiKey: "secret-key",
    headers: { Authorization: "Bearer secret-token", ordinary: "kept" },
    upload_url: "https://storage.example/file?X-Amz-Credential=credential&X-Amz-Signature=signature",
    links: ["https://storage.example/file?token=secret#fragment"],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    apiKey: "[REDACTED]",
    headers: { Authorization: "[REDACTED]", ordinary: "kept" },
    upload_url: "https://storage.example/file?redacted",
    links: ["https://storage.example/file?redacted#redacted"],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("redact converts cycles and unsupported values into JSON-safe markers", () => {
  const cyclic: Record<string, unknown> = { finite: 1, invalid: Number.NaN, callback: () => undefined };
  cyclic.self = cyclic;
  assert.deepEqual(JSON.parse(JSON.stringify(redact(cyclic))), {
    finite: 1,
    invalid: "[UNSERIALIZABLE]",
    callback: "[UNSERIALIZABLE]",
    self: "[CIRCULAR]",
  });
});
