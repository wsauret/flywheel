/**
 * The reminder for Git worktrees that the agent's own commands created and
 * that still exist when its turn ends or it starts its handoff
 * (ARCH-TOOLS-060, ARCH-DIRECTORIES-016). Each worktree is named once, so an
 * agent that keeps one and says why is not asked again; the agent then
 * removes it or states why it stays.
 */
import { Log } from "../../../../infra/diagnostics/log.js";
import type { CreatedWorktrees } from "../../tools/bash/git/created-worktrees.js";

const log = Log.create({ service: "agent-loop" });

/** Answers the reminder for created worktrees that no earlier reminder named,
 *  or undefined when there are none. */
export function worktreeReminder(worktrees: CreatedWorktrees | undefined, providerSessionKey: string): string | undefined {
  const paths = worktrees?.unreminded() ?? [];
  if (paths.length === 0) return undefined;
  log.info("worktrees that this session created still exist; reminding the agent", { worktrees: paths, providerSessionKey });
  const list = paths.map((path) => `- ${path}`).join("\n");
  return `[worktree reminder] These Git worktrees, which your commands created, still exist:\n${list}\nRemove each one before you hand off or report. Keep one only when it holds unpublished work, and then say in your report why it stays.`;
}
