import { stat } from "node:fs/promises";
import type { OutputAcceptContext } from "../../workflows/output-contract/accept.js";
import type { ReadCommandEvidence } from "../../workflows/output-contract/evidence.js";

/** The context of one handoff call: the handoff boundary reads the worker's
 *  files and commands through it. */
export function createOutputAcceptContext(
  executionCwd: string,
  scratchDir?: string,
  readCommandEvidence?: ReadCommandEvidence,
): OutputAcceptContext {
  return {
    executionCwd,
    ...(scratchDir ? { scratchDir } : {}),
    ...(readCommandEvidence ? { readCommandEvidence } : {}),
    pathExists: async (filePath) => await stat(filePath).then(() => true, () => false),
    fileExists: async (filePath) => await stat(filePath).then((entry) => entry.isFile(), () => false),
    readText: async (filePath, maxBytes) => {
      const file = Bun.file(filePath);
      if (maxBytes !== undefined && file.size > maxBytes) {
        throw new Error(`${filePath} is ${file.size} bytes; maximum is ${maxBytes} bytes`);
      }
      return file.text();
    },
  };
}
