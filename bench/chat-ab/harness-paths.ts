// Where the chat-ab harness lives and what it reads and writes.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HARNESS_DIR, "../..");
export const TASKS_DIR = join(HARNESS_DIR, "tasks");
export const RESULTS_ROOT = join(HARNESS_DIR, "results");
