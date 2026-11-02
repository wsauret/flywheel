import type { AgentDefinition } from "../../infra/agent-definition.js";
import { READ_ONLY_SHELL_GUIDANCE } from "./tools/bash-guidance.js";

// The rules that a persona's tool set brings to its task. A persona runs as
// a dispatched subagent or as an agent of a workflow whose record names it
// (docs/terminology.md "persona"), and both read its rules here, so a persona means one
// thing in both places.

/** Whether a tool list holds the write or the edit tool, in any case. */
function hasMutationTool(tools: Iterable<string>, name: "write" | "edit"): boolean {
  for (const tool of tools) {
    if (tool.toLowerCase() === name) return true;
  }
  return false;
}

/** A persona whose own definition grants neither the edit nor the write tool,
 *  as one that excludes the `file_edit` and `file_write` actions does, is
 *  read-only: its shell refuses a command that writes a project file. The
 *  mark is the persona's declaration. It is derived here, not stored on the
 *  definition, so a persona's identity hash stays the hash of what its file
 *  declares. */
export function isReadOnlyPersona(agent: AgentDefinition): boolean {
  return agent.kind === "persona" && !hasMutationTool(agent.tools, "edit") && !hasMutationTool(agent.tools, "write");
}

const GIT_DISCIPLINE = `## Git Discipline

You know what you changed: track the files you touch yourself and report that list in your handoff. Do not run git status, git diff, git log, or git stash to discover, confirm, or protect changes. The working tree may hold other agents' concurrent work; preserve it by avoiding files outside your assignment, not by surveying the tree. Consult git only when your assignment explicitly requires git state. Never rebuild a prior state (worktree, checkout, stash) to manufacture red-run evidence; when a required red run cannot fail because the change already exists, say so in your handoff instead.`;

const SHELL_SAFETY = `## Safety

Never run destructive commands (\`rm -rf\`, \`git clean -fd\`, \`git reset --hard\`, \`git checkout .\`). Commands targeting only \`/tmp\` are allowed.`;

/** The git discipline of an agent that can change files, whose premise is
 *  that the agent knows its own changes, or undefined for any other. */
export function gitDisciplineRule(toolNames: readonly string[]): string | undefined {
  return hasMutationTool(toolNames, "write") || hasMutationTool(toolNames, "edit") ? GIT_DISCIPLINE : undefined;
}

/** The sections that state what an agent may do: which advertised tools it
 *  may call, the read-only rule that its shell enforces when it can change
 *  no file, and shell safety when it can run commands. Every agent of a chat
 *  tree is advertised the same tools, so its opening turn names the ones
 *  that do not work for it. `usable` must be the set its execution refuses
 *  nothing in (`ToolExposurePlan.usable`), so the notice and the refusals
 *  read one set. The notice states the shorter of the usable list and the
 *  refused list; an agent that may call nothing is told to answer in text.
 *  The rules follow the agent's authority, not tool names, because a model's
 *  interaction contract can expose a granted tool under another name (edit as
 *  apply_patch): `readOnly` is the read-only mark that its shell
 *  enforces, and `shell` says whether it may call its shell tool. */
export function toolGrantRules(usable: readonly string[], advertised: readonly string[], authority: { readonly readOnly: boolean; readonly shell: boolean }): readonly string[] {
  if (usable.length === 0) return ["## Tools\n\nCall no tools. Every tool call is refused; answer in text."];
  const refused = advertised.filter((name) => !usable.includes(name));
  const notice = refused.length > 0 && refused.length < usable.length
    ? `These listed tools do not work for you: ${refused.join(", ")}. Do not call them; a call is refused.`
    : `You may call these tools: ${usable.join(", ")}. A call to any other tool is refused.`;
  const sections = [`## Tools\n\n${notice}`];
  if (authority.readOnly) sections.push(`## Read-Only\n\n${READ_ONLY_SHELL_GUIDANCE}`);
  if (authority.shell) sections.push(SHELL_SAFETY);
  return sections;
}
