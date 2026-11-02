import { onCleanup } from "solid-js";
import { appendFileEnsuringDir, writeFileAtomic } from "../../infra/atomic-write.js";
import { resolveComposerHistoryPath } from "../../infra/paths.js";
import { registerPreExitCleanup } from "../exit.js";
import { createPromptHistory } from "./create-composer-history.js";
import { loadPromptHistorySync } from "./composer-history-loader.js";

function toJsonLines(entries: readonly string[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

export function usePromptHistoryPersistence(projectRoot: string): ReturnType<typeof createPromptHistory> {
  const historyPath = resolveComposerHistoryPath(projectRoot);
  const promptHistory = createPromptHistory(loadPromptHistorySync(historyPath), {
    append: async (lines) => appendFileEnsuringDir(historyPath, toJsonLines(lines)),
    rewrite: async (entries) => writeFileAtomic(historyPath, toJsonLines(entries)),
  });
  registerPreExitCleanup(() => promptHistory.flush());
  onCleanup(() => { promptHistory.dispose(); });
  return promptHistory;
}
