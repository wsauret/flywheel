import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asRecord } from "../../../../infra/record.js";
import type { CliBlock } from "../cli-view.js";
import { cliProjectSlug, transcriptRows } from "../transcript.js";
import { DISPATCH_TEXT, type HostedView } from "./engine-text.js";

// An agent file is the conversation of one hosted agent where its host's engine reads it at each dispatch:
// `subagents/agent-<id>.jsonl` in the host session's folder, beside `agent-<id>.meta.json`, which names the agent's
// definition (spike results, "Engine-added text and recording rule"). The engine reads the whole file when a dispatch
// resumes the agent, and appends a row for each block of each response while the agent runs.

/** Where the agents of one host session keep their files. */
export interface AgentFolder {
  readonly configDir: string;
  /** The host's working directory, as its real path. */
  readonly cwd: string;
  readonly sessionId: string;
}

/** The folder of the host session in the login's `projects` folder. The engine keeps the dispatcher's own transcript
 *  beside it as `<sessionId>.jsonl`. */
export function hostSessionFolder(folder: AgentFolder): string {
  return join(folder.configDir, "projects", cliProjectSlug(folder.cwd), folder.sessionId);
}

export function agentFilePath(folder: AgentFolder, agentId: string): string {
  return join(hostSessionFolder(folder), "subagents", `agent-${agentId}.jsonl`);
}

/** What one agent file states about its agent. */
export interface AgentFileInput {
  readonly agentId: string;
  /** The agent type that names the agent's definition, `<plugin>:<name>`. */
  readonly agentType: string;
  /** The model id that assistant rows name. */
  readonly model: string;
  /** The agent's working directory, as the environment rows of its conversation state it. A resumed agent runs there,
   *  whatever the directory of its host, and the engine adds no change rows because the two directories are equal. */
  readonly cwd: string;
  /** The conversation up to the request that the next dispatch serves. Its last dispatch wrapper, which that dispatch
   *  adds, is not written. */
  readonly view: HostedView;
  /** The login's account email (`TranscriptInput.accountEmail`). */
  readonly accountEmail?: string;
  /** The shell that the engine names (`TranscriptInput.shell`). */
  readonly shell?: string;
}

/**
 * Writes the agent's file and its meta file, replacing what they held, and returns the file's size: the offset from
 * which the engine's own rows of the dispatch follow. The rows are the rotation transcript's rows (`transcriptRows`)
 * marked as the agent's, with the engine's row for each earlier dispatch.
 */
export function writeAgentFile(folder: AgentFolder, input: AgentFileInput): number {
  const path = agentFilePath(folder, input.agentId);
  const rows = transcriptRows({
    sessionId: folder.sessionId, model: input.model, history: input.view.messages, reminders: input.view.reminders,
    ...(input.accountEmail === undefined ? {} : { accountEmail: input.accountEmail }), ...(input.shell === undefined ? {} : { shell: input.shell }),
    agent: { agentId: input.agentId, dispatches: input.view.dispatches.slice(0, -1), dispatchText: DISPATCH_TEXT },
  });
  const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  mkdirSync(join(hostSessionFolder(folder), "subagents"), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  writeFileSync(path.replace(/\.jsonl$/u, ".meta.json"), JSON.stringify({
    agentType: input.agentType, description: `Flywheel agent ${input.agentId}`, cwd: input.cwd, spawnDepth: 1, "requestShape": "background", requestNonInteractive: true, finished: true,
  }), { mode: 0o600 });
  return Buffer.byteLength(text);
}

/** Removes the agent's file and its meta file. */
export function removeAgentFile(folder: AgentFolder, agentId: string): void {
  const path = agentFilePath(folder, agentId);
  rmSync(path, { force: true });
  rmSync(path.replace(/\.jsonl$/u, ".meta.json"), { force: true });
}

/** A signed block of a response, as the engine wrote it to the agent file. */
export type SignedBlock = Extract<CliBlock, { type: "thinking" | "redacted_thinking" }>;

/** The engine's rows of one agent file, read as the engine appends them. */
export interface AgentRows {
  /** Reads what the engine appended since the last read and returns every signed block so far, in order. A row that
   *  the engine is still writing waits for the next read. */
  read(): readonly SignedBlock[];
}

/** The reader of the rows that the engine appends to the agent file at `path` after `offset`. Each read reads only the
 *  bytes after the previous one. */
export function agentRows(path: string, offset: number): AgentRows {
  let position = offset;
  const signed: SignedBlock[] = [];
  return {
    read() {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        return signed;
      }
      if (size <= position) return signed;
      const buffer = Buffer.alloc(size - position);
      const descriptor = openSync(path, "r");
      try {
        readSync(descriptor, buffer, 0, buffer.length, position);
      } finally {
        closeSync(descriptor);
      }
      const whole = buffer.lastIndexOf(0x0a) + 1;
      position += whole;
      for (const line of buffer.subarray(0, whole).toString("utf8").split("\n")) {
        const row = parsedRow(line);
        const message = row?.["type"] === "assistant" ? asRecord(row["message"]) : undefined;
        const content = message?.["content"];
        if (!Array.isArray(content)) continue;
        for (const value of content) {
          const block = asRecord(value);
          if (block?.["type"] === "thinking" && typeof block["thinking"] === "string" && typeof block["signature"] === "string") {
            signed.push({ type: "thinking", thinking: block["thinking"], signature: block["signature"] });
          } else if (block?.["type"] === "redacted_thinking" && typeof block["data"] === "string") {
            signed.push({ type: "redacted_thinking", data: block["data"] });
          }
        }
      }
      return signed;
    },
  };
}

/** One row of the engine's own writing as a record, or undefined for a line that is not a JSON object. */
function parsedRow(line: string): { readonly [field: string]: unknown } | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}
