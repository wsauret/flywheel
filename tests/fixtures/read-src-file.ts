import { fileURLToPath } from "node:url"
// Shared test helper: read a source file under src/ as text for substring
// assertions. Agents.md section 8: "Bun is the framework - Bun.file() not fs wrappers."
// Path is given relative to src/ (e.g. "orchestration/workflow-host/agent-callback.ts").

export const readSrcFile = (relativeFromSrc: string): Promise<string> =>
  Bun.file(fileURLToPath(new URL(`../../src/${relativeFromSrc}`, import.meta.url))).text();
