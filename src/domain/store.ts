import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { redact } from "./redact.js";
import { parseRunRecord } from "./types.js";
import type { RunFilters, RunRecord } from "./types.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validateRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
}

function searchableRunValues(run: RunRecord): string[] {
  return [
    run.runId,
    run.parentRunId,
    run.rootRunId,
    run.composioSessionId,
    run.input.csvName,
    run.input.folderId,
    run.input.userId,
    ...run.artifacts.flatMap((artifact) => [artifact.name, artifact.value]),
  ].filter((value): value is string => value !== null);
}

/** Persists sanitized run records as one atomically replaced JSON file per local run. */
export class JsonRunStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  /** Saves a run atomically so readers never observe truncated JSON. */
  async save(run: RunRecord): Promise<void> {
    validateRunId(run.runId);
    const saveOperation = this.writeQueue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const filename = path.join(this.directory, `${run.runId}.json`);
      const temporaryFilename = path.join(this.directory, `.${run.runId}.${process.pid}.${Date.now()}.tmp`);
      const sanitized = parseRunRecord(redact(run));
      try {
        await writeFile(temporaryFilename, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryFilename, filename);
      } finally {
        await rm(temporaryFilename, { force: true });
      }
    });
    this.writeQueue = saveOperation.catch(() => undefined);
    return saveOperation;
  }

  /** Retrieves one validated run without allowing a run ID to escape the store directory. */
  async get(runId: string): Promise<RunRecord | null> {
    validateRunId(runId);
    try {
      const serialized = await readFile(path.join(this.directory, `${runId}.json`), "utf8");
      return parseRunRecord(JSON.parse(serialized) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new Error(`Corrupt run JSON for ${runId}`, { cause: error });
      throw error;
    }
  }

  /** Lists runs matching exact session/run fields plus an optional case-insensitive search. */
  async list(filters: RunFilters = {}): Promise<RunRecord[]> {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter((name) => SAFE_RUN_ID.test(name.slice(0, -5)) && name.endsWith(".json"));
    const runs = await Promise.all(names.map(async (name) => {
      const serialized = await readFile(path.join(this.directory, name), "utf8");
      try {
        return parseRunRecord(JSON.parse(serialized) as unknown);
      } catch (error) {
        throw new Error(`Corrupt run JSON in ${name}`, { cause: error });
      }
    }));
    const query = filters.query?.trim().toLocaleLowerCase("en-US");
    return runs
      .filter((run) => filters.status === undefined || run.status === filters.status)
      .filter((run) => filters.mode === undefined || run.mode === filters.mode)
      .filter((run) => filters.sessionId === undefined || run.composioSessionId === filters.sessionId)
      .filter((run) => filters.rootRunId === undefined || run.rootRunId === filters.rootRunId)
      .filter((run) => filters.parentRunId === undefined || run.parentRunId === filters.parentRunId)
      .filter((run) => !query || searchableRunValues(run).some((value) => value.toLocaleLowerCase("en-US").includes(query)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId));
  }

  /** Lists every local run associated with one concrete Composio session ID. */
  listSessionRuns(sessionId: string): Promise<RunRecord[]> {
    if (!sessionId.trim()) throw new Error("Session ID is required");
    return this.list({ sessionId });
  }
}
