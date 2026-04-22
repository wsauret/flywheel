import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FLYWHEEL_DIR = ".flywheel";

export const MODELS_CACHE_DIR = path.join(os.homedir(), ".cache", "flywheel", "models");
export const AUTH_DIR = path.join(os.homedir(), ".cache", "flywheel", "auth");
export const SESSIONS_DIR = `${FLYWHEEL_DIR}/sessions`;
export const LOG_DIR = `${FLYWHEEL_DIR}/log`;
export const TRACES_DIR = `${FLYWHEEL_DIR}/traces`;

const CONFIG_FILES = ["flywheel.toml", ".flywheel.toml"];

export function findConfigFile(): string | undefined {
  return CONFIG_FILES.find((p) => fs.existsSync(p));
}

export function isHandoffPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replaceAll("\\", "/");
  return /(^|\/)\.flywheel\/sessions\/[^/]+\/handoffs\/.+$/.test(normalized);
}

function sessionDir(sessionId: string): string {
  return `${SESSIONS_DIR}/${sessionId}`;
}

function sessionHandoffsDir(sessionId: string): string {
  return `${sessionDir(sessionId)}/handoffs`;
}

export function resolveSessionDir(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, sessionDir(sessionId));
}

export function resolveSessionHandoffsDir(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, sessionHandoffsDir(sessionId));
}

export function ensureSessionDir(sessionId: string, baseDir: string): void {
  const handoffsPath = resolveSessionHandoffsDir(sessionId, baseDir);
  fs.mkdirSync(handoffsPath, { recursive: true });
}

const SESSION_FILES = {
  session: "session.json",
  plan: "plan.json",
  research: "research.md",
  review: "review.md",
  output: "output.json",
  transcript: "transcript.jsonl",
  queue: "queue.json",
  context: "context.json",
} as const;

export function resolveSessionFile(
  sessionId: string,
  file: keyof typeof SESSION_FILES,
  baseDir: string,
): string {
  return path.resolve(baseDir, sessionDir(sessionId), SESSION_FILES[file]);
}

export function buildWorkerHandoffPath(
  sessionId: string,
  stepType: string,
  stepId: string,
  baseDir: string,
): string {
  return path.resolve(baseDir, sessionHandoffsDir(sessionId), `${stepType}_${stepId}.json`);
}

export function buildInvocationHandoffPath(
  role: "dispatcher" | "evaluator",
  sessionId: string,
  invocationId: string,
  baseDir: string,
): string {
  return path.resolve(baseDir, sessionHandoffsDir(sessionId), `${role}_${invocationId}.json`);
}

export function ensureTracesDir(baseDir: string): void {
  fs.mkdirSync(path.resolve(baseDir, TRACES_DIR), { recursive: true });
}

export function resolveTraceFile(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, `${sessionId}.jsonl`);
}

export function resolveTranscriptFile(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, `${sessionId}.ndjson`);
}
