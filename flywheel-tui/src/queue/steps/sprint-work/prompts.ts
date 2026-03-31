import type { ContextEntry } from "../../../schemas.js";

export const SCOPE_DISCIPLINE = `## Scope Discipline

When in doubt, do less. Premature abstraction costs more than duplication. YAGNI — implement what's needed now, not what might be needed later.`;

export const THREE_STRIKE_PROTOCOL = `## Three-Strike Protocol

- **Strike 1 — Diagnose:** Understand the error, research if needed.
- **Strike 2 — Alternative approach:** Different strategy for the same goal.
- **Strike 3 — Broader rethink:** Question assumptions, reduce scope.
- **After 3 strikes:** Escalate to user with full context of what was tried and why it failed.`;

export function buildProjectContextSection(extra?: Record<string, unknown>): string {
  if (!extra) return "";

  const conventions = (extra.conventions ?? []) as ContextEntry[];
  const standards = (extra.standards ?? []) as ContextEntry[];
  const learnings = (extra.learnings ?? []) as ContextEntry[];

  const hasAny = conventions.length > 0 || standards.length > 0 || learnings.length > 0;
  if (!hasAny) return "";

  const formatEntries = (entries: ContextEntry[]): string =>
    entries.map((e) => `- \`${e.path}\` — ${e.summary}`).join("\n");

  const sections: string[] = [];

  if (conventions.length > 0) {
    sections.push(`### Conventions\n${formatEntries(conventions)}`);
  }
  if (standards.length > 0) {
    sections.push(`### Standards\n${formatEntries(standards)}`);
  }
  if (learnings.length > 0) {
    sections.push(`### Learnings\n${formatEntries(learnings)}`);
  }

  return `## Project Context

The following project files contain conventions and standards relevant to this step.
Read them before starting implementation.

${sections.join("\n\n")}`;
}
