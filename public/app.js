const API_ROUTES = {
  health: "/api/health",
  sessions: "/api/sessions",
  session: (runId) => `/api/sessions/${encodeURIComponent(runId)}`,
  runs: "/api/runs",
  replay: (runId) => `/api/runs/${encodeURIComponent(runId)}/replay`,
  compare: (runId, otherRunId) => `/api/runs/${encodeURIComponent(runId)}/compare/${encodeURIComponent(otherRunId)}`,
  export: (runId) => `/api/runs/${encodeURIComponent(runId)}/export`,
};

const state = {
  runs: [],
  runCatalog: [],
  /** The driver the server will actually execute with, reported by /api/health. */
  driverMode: null,
  selectedRun: null,
  query: "",
  status: "",
  exportBundle: null,
  searchTimer: null,
};

const elements = Object.fromEntries([
  "run-list", "run-count", "run-query", "run-status", "run-detail", "detail-empty", "detail-content",
  "detail-status", "detail-mode", "detail-title", "detail-identity", "write-notice",
  "run-error", "run-error-category", "run-error-message",
  "summary-rows", "summary-total", "summary-categories", "summary-duration", "step-count",
  "timeline", "artifact-list", "comparison-run", "comparison-content", "replay-button",
  "export-button", "run-dialog", "run-form", "csv-file", "csv-file-label", "csv-file-help",
  "run-user-id", "run-folder-id", "new-run-destination", "new-run-mode-copy", "run-form-error",
  "start-run-button", "replay-dialog", "replay-form", "replay-csv-file", "replay-file-label",
  "replay-file-help", "replay-csv-was", "replay-folder-was", "replay-user-was",
  "replace-folder-toggle", "replay-folder-field", "replay-folder-id", "replay-destination",
  "replace-user-toggle", "replay-user-field", "replay-user-id",
  "replay-mode-copy", "replay-form-error", "start-replay-button", "export-dialog", "export-body",
  "download-export", "close-export", "toast-region", "global-mode-dot", "global-mode-label",
  "global-mode-help",
].map((id) => [id, document.getElementById(id)]));

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeDisplayValue(value, key = "") {
  const secretKey = /authorization|api[-_]?key|token|secret|cookie|password|credential/i;
  const urlKey = /upload_url|download_url|source_url|binary_data/i;
  if (secretKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (urlKey.test(key) || /^https?:\/\//.test(value)) {
      try {
        const url = new URL(value);
        if (url.search) url.search = "?redacted";
        return url.toString();
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => safeDisplayValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, safeDisplayValue(child, childKey)]));
  }
  return value;
}

function formatPayload(value) {
  return JSON.stringify(safeDisplayValue(value), null, 2) ?? "null";
}

function highlightJson(value) {
  const json = formatPayload(value);
  const tokens = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let markup = "";
  let cursor = 0;
  for (const match of json.matchAll(tokens)) {
    const offset = match.index ?? 0;
    markup += escapeHtml(json.slice(cursor, offset));
    const [token, stringToken, keySuffix, literal] = match;
    if (stringToken) {
      const tokenClass = keySuffix
        ? "json-key"
        : /\[REDACTED\]|redacted/i.test(stringToken)
          ? "json-redacted"
          : "json-string";
      markup += `<span class="${tokenClass}">${escapeHtml(stringToken)}</span>${escapeHtml(keySuffix ?? "")}`;
    } else if (literal) {
      markup += `<span class="json-${literal === "null" ? "null" : "boolean"}">${escapeHtml(token)}</span>`;
    } else {
      markup += `<span class="json-number">${escapeHtml(token)}</span>`;
    }
    cursor = offset + token.length;
  }
  return markup + escapeHtml(json.slice(cursor));
}

function describePayload(value) {
  const safe = safeDisplayValue(value);
  const type = Array.isArray(safe)
    ? `${safe.length} ${safe.length === 1 ? "item" : "items"}`
    : safe && typeof safe === "object"
      ? `${Object.keys(safe).length} ${Object.keys(safe).length === 1 ? "field" : "fields"}`
      : safe === null
        ? "null"
        : typeof safe;
  const bytes = new TextEncoder().encode(formatPayload(value)).byteLength;
  return `${type} · ${bytes.toLocaleString()} B`;
}

function renderPayload(label, value) {
  return `<div class="payload">
    <div class="payload-heading"><span>${escapeHtml(label)}</span><small>${escapeHtml(describePayload(value))}</small></div>
    <pre class="json-view"><code>${highlightJson(value)}</code></pre>
  </div>`;
}

function formatDate(isoDate) {
  if (!isoDate) return "In progress";
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatDuration(run) {
  if (!run?.finishedAt) return "In progress";
  const duration = new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) return "—";
  if (duration < 1000) return `${duration} ms`;
  return `${(duration / 1000).toFixed(duration < 10000 ? 1 : 0)} s`;
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Unknown";
}

const STATUS_LABELS = {
  running: "Running",
  verified: "Verified",
  failed: "Failed",
  unknown: "Unknown outcome",
  unsupported: "Unsupported step",
  cleanup_failed: "Cleanup failed",
};

function statusClass(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? status.replaceAll("_", "-") : "unknown";
}

function outcomeLabel(run) {
  if (run.status !== "verified") return STATUS_LABELS[run.status] ?? "Unknown outcome";
  return run.mode === "live" ? "Verified live" : "Verified simulation";
}

function modeCopy(mode) {
  if (mode === "live") return "Live Composio execution. A successful run writes a new report to the folder shown above.";
  if (mode === "fake") return "Simulation only. No file is written to Google Drive, even when the run is verified.";
  return "The server will identify whether this is a fake or live execution in the result.";
}

async function apiRequest(path, options = {}) {
  const headers = options.body ? { "content-type": "application/json", ...options.headers } : options.headers;
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body ? body.error : `${response.status} ${response.statusText}`;
    throw new Error(String(message));
  }
  return body;
}

function showToast(message, kind = "success") {
  const toast = document.createElement("div");
  toast.className = `toast${kind === "error" ? " is-error" : ""}`;
  toast.textContent = message;
  elements["toast-region"].append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

/** Reports the server's own driver: a historical run's mode says nothing about what the next run will do. */
function renderGlobalMode() {
  const mode = state.driverMode;
  elements["global-mode-dot"].className = `mode-indicator ${mode ? `is-${mode}` : "is-unknown"}`;
  if (mode === "fake") {
    elements["global-mode-label"].textContent = "Fake driver active";
    elements["global-mode-help"].textContent = "No provider writes";
  } else if (mode === "live") {
    elements["global-mode-label"].textContent = "Live Composio active";
    elements["global-mode-help"].textContent = "Provider writes enabled";
  } else {
    elements["global-mode-label"].textContent = "Mode not confirmed";
    elements["global-mode-help"].textContent = "Server driver unavailable";
  }
  elements["new-run-mode-copy"].textContent = modeCopy(mode);
}

async function loadDriverMode() {
  try {
    const health = await apiRequest(API_ROUTES.health);
    state.driverMode = health.mode === "live" || health.mode === "fake" ? health.mode : null;
  } catch {
    state.driverMode = null;
  }
  renderGlobalMode();
}

function renderRunList() {
  elements["run-count"].textContent = String(state.runs.length);
  elements["run-list"].setAttribute("aria-busy", "false");
  if (state.runs.length === 0) {
    elements["run-list"].innerHTML = `<div class="empty-list"><strong>No matching runs</strong><span>Change the filters or start a new run.</span></div>`;
    return;
  }
  elements["run-list"].innerHTML = state.runs.map((run) => {
    const selected = run.runId === state.selectedRun?.runId;
    const status = statusClass(run.status);
    return `<button class="run-list-item${selected ? " is-selected" : ""}" data-run-id="${escapeHtml(run.runId)}" aria-pressed="${selected}">
      <span class="run-file-icon"><svg aria-hidden="true"><use href="#icon-file"></use></svg></span>
      <span class="run-list-copy">
        <strong>${escapeHtml(run.input?.csvName ?? "Unnamed CSV")}</strong>
        <span>${escapeHtml(formatDate(run.createdAt))}</span>
        <span class="list-status status-${status}">${escapeHtml(outcomeLabel(run))}</span>
      </span>
      <span class="run-list-arrow"><svg aria-hidden="true"><use href="#icon-arrow"></use></svg></span>
    </button>`;
  }).join("");
  elements["run-list"].querySelectorAll("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => selectRun(button.dataset.runId));
  });
}

async function loadRuns({ preserveSelection = true } = {}) {
  elements["run-list"].setAttribute("aria-busy", "true");
  elements["run-list"].innerHTML = `<div class="loading-state"><span class="spinner"></span>Loading runs…</div>`;
  const params = new URLSearchParams();
  if (state.query) params.set("query", state.query);
  if (state.status) params.set("status", state.status);
  try {
    const runs = await apiRequest(`${API_ROUTES.sessions}?${params}`);
    state.runs = Array.isArray(runs) ? runs : [];
    state.runCatalog = state.query || state.status
      ? await apiRequest(API_ROUTES.sessions)
      : state.runs;
    const retained = preserveSelection && state.selectedRun && state.runs.some((run) => run.runId === state.selectedRun.runId);
    renderRunList();
    renderGlobalMode();
    if (!retained && state.runs.length > 0) await selectRun(state.runs[0].runId);
    if (!retained && state.runs.length === 0) clearRunDetail();
  } catch (error) {
    state.runs = [];
    elements["run-list"].setAttribute("aria-busy", "false");
    elements["run-list"].innerHTML = `<div class="empty-list"><strong>Runs could not load</strong><span>${escapeHtml(error.message)}</span></div>`;
    clearRunDetail();
  }
}

function clearRunDetail() {
  state.selectedRun = null;
  elements["detail-empty"].hidden = false;
  elements["detail-content"].hidden = true;
  renderGlobalMode();
}

async function selectRun(runId) {
  try {
    const run = await apiRequest(API_ROUTES.session(runId));
    state.selectedRun = run;
    const listIndex = state.runs.findIndex((item) => item.runId === runId);
    if (listIndex >= 0) state.runs[listIndex] = run;
    renderRunList();
    renderRunDetail(run);
    renderGlobalMode();
    if (window.matchMedia("(max-width: 720px)").matches) {
      elements["run-detail"].scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    showToast(`Run could not load: ${error.message}`, "error");
  }
}

function renderRunDetail(run) {
  elements["detail-empty"].hidden = true;
  elements["detail-content"].hidden = false;
  const status = statusClass(run.status);
  elements["detail-status"].className = `status-badge status-${status}`;
  elements["detail-status"].textContent = outcomeLabel(run);
  elements["detail-mode"].className = `mode-badge mode-${run.mode === "live" ? "live" : "fake"}`;
  elements["detail-mode"].textContent = run.mode === "live" ? "Live mode" : "Fake mode";
  elements["detail-title"].textContent = run.input?.csvName ?? "Unnamed CSV";
  const parent = run.parentRunId ? state.runCatalog.find((candidate) => candidate.runId === run.parentRunId) : null;
  const lineage = run.parentRunId ? ` · replay of ${parent?.input?.csvName ?? run.parentRunId}` : "";
  elements["detail-identity"].textContent = `run ${run.runId}${run.composioSessionId ? ` · session ${run.composioSessionId}` : ""}${lineage}`;
  elements["run-error"].hidden = !run.error;
  if (run.error) {
    elements["run-error-category"].textContent = `${run.error.category} error`;
    elements["run-error-message"].textContent = run.error.message;
  }
  const verified = run.status === "verified";
  elements["write-notice"].className = `write-notice is-${verified ? (run.mode === "live" ? "live" : "fake") : "stopped"}`;
  elements["write-notice"].textContent = verified
    ? (run.mode === "live"
      ? `Live write destination: Google Drive folder ${run.input.folderId}. Verified means the provider output was checked.`
      : `Simulated destination: Google Drive folder ${run.input.folderId}. No provider file was created by this fake run.`)
    : `Intended destination: Google Drive folder ${run.input.folderId}. This run is ${(STATUS_LABELS[run.status] ?? "not verified").toLowerCase()}, so no report is confirmed there.`;
  elements["summary-rows"].textContent = run.summary?.inputRows ?? "—";
  elements["summary-total"].textContent = run.summary ? run.summary.grandTotal : "—";
  elements["summary-categories"].textContent = run.summary?.categories?.length ?? "—";
  elements["summary-duration"].textContent = formatDuration(run);
  elements["replay-button"].disabled = run.status === "running";
  elements["export-button"].disabled = run.status !== "verified";
  renderTimeline(run.events ?? []);
  renderArtifacts(run.artifacts ?? []);
  renderComparisonPicker(run);
  switchDetailTab("timeline");
}

function renderTimeline(events) {
  elements["step-count"].textContent = `${events.length} ${events.length === 1 ? "event" : "events"}`;
  if (!events.length) {
    elements.timeline.innerHTML = `<li class="empty-panel">No recorded events are available for this run.</li>`;
    return;
  }
  elements.timeline.innerHTML = events.map((event, index) => {
    const eventClass = event.status === "error" ? "is-error" : event.status === "unknown" ? "is-unknown" : "is-success";
    const eventVerb = event.kind === "transfer" ? "File transfer" : event.kind === "support" ? "Session support" : "SDK call";
    const outcome = event.status === "success" ? "Completed" : capitalize(event.status);
    return `<li class="timeline-step ${eventClass}">
      <span class="step-marker"><svg aria-hidden="true"><use href="${event.status === "success" ? "#icon-check" : "#icon-clock"}"></use></svg></span>
      <details class="step-card"${index === 0 ? " open" : ""}>
        <summary class="step-summary">
          <span class="step-title"><strong>${escapeHtml(event.operation)}</strong><span>${escapeHtml(outcome)} · ${escapeHtml(formatDate(event.startedAt))}</span></span>
          <span class="step-kind ${event.kind === "transfer" ? "transfer" : ""}">${escapeHtml(eventVerb)}</span>
          <span class="step-duration">${Number(event.durationMs) || 0} ms</span>
        </summary>
        <div class="step-payloads">
          ${renderPayload("Redacted input", event.input)}
          ${renderPayload("Redacted result", event.output)}
        </div>
      </details>
    </li>`;
  }).join("");
}

function renderArtifacts(artifacts) {
  if (!artifacts.length) {
    elements["artifact-list"].innerHTML = `<div class="empty-panel">No file references were recorded.</div>`;
    return;
  }
  elements["artifact-list"].innerHTML = artifacts.map((artifact) => `<div class="artifact-row">
    <span class="file-glyph"><svg aria-hidden="true"><use href="${artifact.kind === "published" ? "#icon-folder" : "#icon-file"}"></use></svg></span>
    <span class="artifact-copy"><strong>${escapeHtml(artifact.name)}</strong><span>${escapeHtml(artifact.value)}</span></span>
    <span class="artifact-type">${escapeHtml(capitalize(artifact.kind))}</span>
  </div>`).join("");
}

function renderComparisonPicker(run) {
  const chainRuns = state.runCatalog
    .filter((candidate) => candidate.rootRunId === run.rootRunId && candidate.status === "verified")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const original = chainRuns.find((candidate) => candidate.runId === candidate.rootRunId) ?? chainRuns[0];
  const replays = chainRuns.filter((candidate) => candidate.runId !== original?.runId);
  elements["comparison-run"].innerHTML = replays.map((candidate) => `<option value="${escapeHtml(candidate.runId)}">${escapeHtml(candidate.input.csvName)} · ${escapeHtml(formatDate(candidate.createdAt))}</option>`).join("");
  elements["comparison-run"].disabled = replays.length === 0;
  elements["comparison-content"].dataset.originalRunId = original?.runId ?? "";
  if (!original || replays.length === 0) {
    elements["comparison-content"].innerHTML = `<div class="empty-panel">Replay this run with a replacement CSV to compare verified outputs.</div>`;
    return;
  }
  const preferred = run.runId !== original.runId && replays.some((candidate) => candidate.runId === run.runId) ? run.runId : replays.at(-1).runId;
  elements["comparison-run"].value = preferred;
  loadComparison(original.runId, preferred);
}

function renderInputDiff(original, replay) {
  const slots = [
    ["csvFile", original?.input?.csvName, replay?.input?.csvName],
    ["folderId", original?.input?.folderId, replay?.input?.folderId],
    ["userId", original?.input?.userId, replay?.input?.userId],
  ];
  return `<div class="input-diff">${slots.map(([name, left, right]) => `<div class="input-diff-row${left === right ? " is-same" : ""}">
    <span class="slot-name">${escapeHtml(name)}</span>
    <code>${escapeHtml(left ?? "—")}</code>
    <svg aria-hidden="true"><use href="#icon-arrow"></use></svg>
    <code>${escapeHtml(right ?? "—")}</code>
    <span class="input-diff-tag">${left === right ? "inherited" : "redefined"}</span>
  </div>`).join("")}</div>`;
}

function renderCategoryDeltas(categories) {
  if (!categories.length) return `<div class="empty-panel">Both runs produced identical category totals.</div>`;
  return `<table class="delta-table">
    <thead><tr><th>Category</th><th>Original</th><th>Replay</th><th>Delta</th><th>Rows</th></tr></thead>
    <tbody>${categories.map((category) => `<tr>
      <td>${escapeHtml(category.category)}</td>
      <td>${escapeHtml(category.leftTotal ?? "—")}</td>
      <td>${escapeHtml(category.rightTotal ?? "—")}</td>
      <td class="${Number(category.totalDelta) < 0 ? "is-down" : "is-up"}">${Number(category.totalDelta) > 0 ? "+" : ""}${escapeHtml(category.totalDelta)}</td>
      <td>${category.rowCountDelta > 0 ? "+" : ""}${category.rowCountDelta}</td>
    </tr>`).join("")}</tbody></table>`;
}

async function loadComparison(originalRunId, replayRunId) {
  elements["comparison-content"].innerHTML = `<div class="loading-state"><span class="spinner"></span>Comparing runs…</div>`;
  try {
    const comparison = await apiRequest(API_ROUTES.compare(originalRunId, replayRunId));
    const original = state.runCatalog.find((run) => run.runId === originalRunId);
    const replay = state.runCatalog.find((run) => run.runId === replayRunId);
    const changes = [
      ...(comparison.addedCategories ?? []).map((category) => `<span class="change-chip added">Added ${escapeHtml(category)}</span>`),
      ...(comparison.removedCategories ?? []).map((category) => `<span class="change-chip removed">Removed ${escapeHtml(category)}</span>`),
    ].join("");
    elements["comparison-content"].innerHTML = `<div class="comparison-grid">
      <div class="comparison-card"><span>Original</span><strong>${escapeHtml(original?.input?.csvName ?? originalRunId)}</strong><strong class="comparison-total">${escapeHtml(original?.summary?.grandTotal ?? "—")}</strong><small>${original?.summary?.inputRows ?? "—"} rows</small></div>
      <div class="comparison-arrow"><svg aria-hidden="true"><use href="#icon-arrow"></use></svg></div>
      <div class="comparison-card"><span>Replay</span><strong>${escapeHtml(replay?.input?.csvName ?? replayRunId)}</strong><strong class="comparison-total">${escapeHtml(replay?.summary?.grandTotal ?? "—")}</strong><small>${replay?.summary?.inputRows ?? "—"} rows</small></div>
    </div>
    <div class="delta-panel"><span>Grand total change</span><strong>${Number(comparison.totalDelta) > 0 ? "+" : ""}${escapeHtml(comparison.totalDelta)}</strong></div>
    ${changes ? `<div class="change-list">${changes}</div>` : ""}
    <div class="comparison-section"><h4>Redefined inputs</h4>${renderInputDiff(original, replay)}</div>
    <div class="comparison-section"><h4>Category totals</h4>${renderCategoryDeltas(comparison.changedCategories ?? [])}</div>`;
  } catch (error) {
    elements["comparison-content"].innerHTML = `<div class="empty-panel">Comparison failed: ${escapeHtml(error.message)}</div>`;
  }
}

function switchDetailTab(tabName) {
  ["timeline", "comparison", "artifacts"].forEach((name) => {
    const tab = document.getElementById(`${name}-tab`);
    const panel = document.getElementById(`${name}-panel`);
    const selected = name === tabName;
    tab.setAttribute("aria-selected", String(selected));
    panel.hidden = !selected;
  });
}

function updateFileLabel(input, labelElement, helpElement) {
  const file = input.files?.[0];
  if (!file) return;
  labelElement.textContent = file.name;
  if (helpElement) helpElement.textContent = `${Math.max(1, Math.ceil(file.size / 1024))} KB · ready to upload`;
}

function validateCsvFile(file) {
  if (!file) throw new Error("Choose a CSV file.");
  if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("The input file must use the .csv extension.");
  if (file.size > 1024 * 1024) throw new Error("The CSV exceeds the 1 MiB limit.");
  if (file.size === 0) throw new Error("The CSV is empty.");
}

function openNewRunDialog() {
  elements["run-form"].reset();
  elements["csv-file-label"].textContent = "Choose a CSV file";
  elements["csv-file-help"].textContent = "UTF-8 · category and amount columns · up to 1 MiB";
  elements["new-run-destination"].textContent = "Select a Google Drive folder ID";
  elements["run-form-error"].hidden = true;
  renderGlobalMode();
  elements["run-dialog"].showModal();
}

async function submitNewRun(event) {
  event.preventDefault();
  const file = elements["csv-file"].files?.[0];
  try {
    validateCsvFile(file);
    elements["run-form-error"].hidden = true;
    elements["start-run-button"].disabled = true;
    elements["start-run-button"].textContent = "Running…";
    const run = await apiRequest(API_ROUTES.runs, {
      method: "POST",
      body: JSON.stringify({
        csvName: file.name,
        csvContent: await file.text(),
        folderId: elements["run-folder-id"].value.trim(),
        userId: elements["run-user-id"].value.trim(),
      }),
    });
    elements["run-dialog"].close();
    state.query = "";
    state.status = "";
    elements["run-query"].value = "";
    elements["run-status"].value = "";
    await loadRuns({ preserveSelection: false });
    await selectRun(run.runId);
    showToast(run.mode === "live" ? "Live run completed and its provider write was recorded." : "Simulation completed. No provider file was created.");
  } catch (error) {
    elements["run-form-error"].textContent = error.message;
    elements["run-form-error"].hidden = false;
  } finally {
    elements["start-run-button"].disabled = false;
    elements["start-run-button"].textContent = "Start run";
  }
}

function openReplayDialog() {
  const run = state.selectedRun;
  if (!run) return;
  elements["replay-form"].reset();
  elements["replay-file-label"].textContent = "Choose a replacement CSV";
  elements["replay-file-help"].textContent = "UTF-8 · category and amount columns · up to 1 MiB";
  elements["replay-folder-field"].hidden = true;
  elements["replay-user-field"].hidden = true;
  elements["replay-form-error"].hidden = true;
  elements["replay-csv-was"].textContent = run.input.csvName;
  elements["replay-folder-was"].textContent = run.input.folderId;
  elements["replay-user-was"].textContent = run.input.userId;
  updateReplayDestination();
  elements["replay-dialog"].showModal();
}

function updateReplayDestination() {
  const original = state.selectedRun?.input ?? {};
  const folderReplacement = elements["replay-folder-id"].value.trim();
  const userReplacement = elements["replay-user-id"].value.trim();
  const folder = elements["replace-folder-toggle"].checked && folderReplacement ? folderReplacement : original.folderId ?? "";
  const user = elements["replace-user-toggle"].checked && userReplacement ? userReplacement : original.userId ?? "";
  elements["replay-destination"].textContent = `Google Drive folder ${folder || "not selected"}`;
  elements["replay-mode-copy"].textContent = `Runs as user ${user || "not selected"}. ${modeCopy(state.driverMode)}`;
}

async function submitReplay(event) {
  event.preventDefault();
  const sourceRun = state.selectedRun;
  const file = elements["replay-csv-file"].files?.[0];
  if (!sourceRun) return;
  try {
    validateCsvFile(file);
    const replaceFolder = elements["replace-folder-toggle"].checked;
    const folderId = elements["replay-folder-id"].value.trim();
    if (replaceFolder && !folderId) throw new Error("Enter the replacement Google Drive folder ID.");
    const replaceUser = elements["replace-user-toggle"].checked;
    const userId = elements["replay-user-id"].value.trim();
    if (replaceUser && !userId) throw new Error("Enter the replacement user ID.");
    elements["replay-form-error"].hidden = true;
    elements["start-replay-button"].disabled = true;
    elements["start-replay-button"].textContent = "Replaying…";
    const body = { csvName: file.name, csvContent: await file.text() };
    if (replaceFolder) body.folderId = folderId;
    if (replaceUser) body.userId = userId;
    const replay = await apiRequest(API_ROUTES.replay(sourceRun.runId), { method: "POST", body: JSON.stringify(body) });
    elements["replay-dialog"].close();
    state.query = "";
    state.status = "";
    elements["run-query"].value = "";
    elements["run-status"].value = "";
    await loadRuns({ preserveSelection: false });
    await selectRun(replay.runId);
    showToast(replay.mode === "live" ? "Replay completed with a new live provider write." : "Replay simulation completed. No provider file was created.");
  } catch (error) {
    elements["replay-form-error"].textContent = error.message;
    elements["replay-form-error"].hidden = false;
  } finally {
    elements["start-replay-button"].disabled = false;
    elements["start-replay-button"].textContent = "Start replay";
  }
}

async function openExportDialog() {
  const run = state.selectedRun;
  if (!run) return;
  state.exportBundle = null;
  elements["download-export"].disabled = true;
  elements["export-body"].innerHTML = `<div class="loading-state"><span class="spinner"></span>Preparing export…</div>`;
  elements["export-dialog"].showModal();
  try {
    const bundle = await apiRequest(API_ROUTES.export(run.runId), { method: "POST" });
    state.exportBundle = bundle;
    elements["download-export"].disabled = false;
    const files = Object.entries(bundle.files ?? {});
    elements["export-body"].innerHTML = `<div class="manifest-preview"><span>Workflow</span><strong>${escapeHtml(bundle.manifest?.workflow ?? "Recorded workflow")}</strong><code>source run ${escapeHtml(bundle.manifest?.sourceRunId ?? run.runId)} · ${files.length} project files</code></div>
      <div class="export-files">${files.map(([name, content], index) => `<details class="export-file"${index === 0 ? " open" : ""}><summary><svg aria-hidden="true"><use href="#icon-file"></use></svg><strong>${escapeHtml(name)}</strong><span>${new Blob([content]).size} bytes</span></summary><pre>${escapeHtml(content)}</pre></details>`).join("")}</div>`;
  } catch (error) {
    elements["export-body"].innerHTML = `<div class="empty-panel">Export failed: ${escapeHtml(error.message)}</div>`;
  }
}

function downloadExportBundle() {
  if (!state.exportBundle) return;
  const blob = new Blob([`${JSON.stringify(state.exportBundle, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = state.exportBundle.filename ?? `composio-replay-${state.selectedRun?.runId ?? "export"}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Export bundle downloaded.");
}

document.querySelectorAll("[data-open-run-dialog]").forEach((button) => button.addEventListener("click", openNewRunDialog));
document.querySelectorAll("[role='tab']").forEach((tab) => tab.addEventListener("click", () => switchDetailTab(tab.id.replace("-tab", ""))));
elements["run-query"].addEventListener("input", () => {
  state.query = elements["run-query"].value.trim();
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => loadRuns({ preserveSelection: true }), 220);
});
elements["run-status"].addEventListener("change", () => { state.status = elements["run-status"].value; loadRuns({ preserveSelection: true }); });
elements["csv-file"].addEventListener("change", () => updateFileLabel(elements["csv-file"], elements["csv-file-label"], elements["csv-file-help"]));
elements["replay-csv-file"].addEventListener("change", () => updateFileLabel(elements["replay-csv-file"], elements["replay-file-label"]));
elements["run-folder-id"].addEventListener("input", () => { elements["new-run-destination"].textContent = elements["run-folder-id"].value.trim() ? `Google Drive folder ${elements["run-folder-id"].value.trim()}` : "Select a Google Drive folder ID"; });
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close());
});
elements["replace-folder-toggle"].addEventListener("change", () => { elements["replay-folder-field"].hidden = !elements["replace-folder-toggle"].checked; updateReplayDestination(); });
elements["replay-folder-id"].addEventListener("input", updateReplayDestination);
elements["replace-user-toggle"].addEventListener("change", () => { elements["replay-user-field"].hidden = !elements["replace-user-toggle"].checked; updateReplayDestination(); });
elements["replay-user-id"].addEventListener("input", updateReplayDestination);
elements["run-form"].addEventListener("submit", submitNewRun);
elements["replay-form"].addEventListener("submit", submitReplay);
elements["replay-button"].addEventListener("click", openReplayDialog);
elements["export-button"].addEventListener("click", openExportDialog);
elements["close-export"].addEventListener("click", () => elements["export-dialog"].close());
elements["download-export"].addEventListener("click", downloadExportBundle);
elements["comparison-run"].addEventListener("change", () => loadComparison(elements["comparison-content"].dataset.originalRunId, elements["comparison-run"].value));

document.querySelectorAll(".drop-zone").forEach((dropZone) => {
  const input = dropZone.querySelector("input[type='file']");
  ["dragenter", "dragover"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove("is-dragging"); }));
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    updateFileLabel(input, dropZone.querySelector("strong"), dropZone.querySelector("small"));
  });
});

loadDriverMode();
loadRuns({ preserveSelection: false });
