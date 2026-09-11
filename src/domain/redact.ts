import type { JsonValue } from "./types.js";

const SECRET_KEY = /(?:^|[-_])(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|cookie|password|credential|private[-_]?key)(?:$|[-_])/i;
const URL_KEY = /(?:url|uri|href|binary_data)/i;
const CREDENTIAL_VALUE = /^(?:bearer|basic)\s+\S+/i;
const SIGNATURE_QUERY = /(?:[?&](?:token|signature|sig|x-amz-(?:credential|signature|security-token))=)[^&#\s]+/gi;
const SENSITIVE_ASSIGNMENT = /(?:\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|signature|secret|password)=)[^&#\s]+/gi;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "redacted";
    }
    if (url.search) url.search = "?redacted";
    if (url.hash) url.hash = "#redacted";
    return url.toString();
  } catch {
    return value
      .replace(SIGNATURE_QUERY, (match) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`)
      .replace(SENSITIVE_ASSIGNMENT, (match) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`);
  }
}

function redactValue(value: unknown, key: string, seen: WeakSet<object>): JsonValue {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) return "[UNSERIALIZABLE]";
    if (typeof value !== "string") return value;
    if (CREDENTIAL_VALUE.test(value)) return "[REDACTED]";
    if (URL_KEY.test(key) || /^https?:\/\//i.test(value) || SIGNATURE_QUERY.test(value) || SENSITIVE_ASSIGNMENT.test(value)) return redactUrl(value);
    SIGNATURE_QUERY.lastIndex = 0;
    SENSITIVE_ASSIGNMENT.lastIndex = 0;
    return value;
  }
  if (typeof value !== "object") return "[UNSERIALIZABLE]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const redacted = value.map((item) => redactValue(item, key, seen));
    seen.delete(value);
    return redacted;
  }
  const redacted: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [childKey, child] of Object.entries(value)) redacted[childKey] = redactValue(child, childKey, seen);
  seen.delete(value);
  return redacted;
}

/** Produces a JSON-safe inspection value with secrets and signed URL credentials removed. */
export function redact(value: unknown, key = ""): JsonValue {
  return redactValue(value, key, new WeakSet<object>());
}
