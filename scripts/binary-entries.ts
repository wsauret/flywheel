import { basename } from "node:path";

/** Every entry the shipped executable embeds, the CLI first and then each
 *  Worker entry. The bundle and the compile both derive their lists from this
 *  one, and the compiled-entry probe starts one Worker for each Worker entry,
 *  so an entry cannot ship in one list and miss the other. The bundle names
 *  each output by its basename alone, so every basename must be unique. */
export const BINARY_ENTRIES = [
  "src/cli/index.ts",
  "src/orchestration/app-service/worker-entry.ts",
  "src/orchestration/agent-runtime/tools/streaming-edit-validation-worker.ts",
  "src/orchestration/agent-runtime/tools/bash-private-copy-worker.ts",
  "src/infra/llm/models-document-worker.ts",
  "src/orchestration/modules/code-mode/code-mode-invocation-worker.ts",
] as const;

/** The flags of the compile step, which turns the bundle into the executable.
 *  The compile re-bundles the entries and must keep the chunks split, or it
 *  would fold them back into one module per entry. Bytecode skips parsing at
 *  each start, and Bun compiles bytecode for ES modules only when the format
 *  says so. */
export const BINARY_COMPILE_FLAGS = ["--compile", "--splitting", "--bytecode", "--format=esm"] as const;

/** The file the bundle step writes for one entry, which the compile step and
 *  `embeddedEntrySpecifier` name. */
export function bundledEntryName(entry: string): string {
  return `${basename(entry, ".ts")}.js`;
}
