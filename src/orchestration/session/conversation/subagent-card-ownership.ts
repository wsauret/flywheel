import { canonicalize } from "../../../infra/canonical-name.js";
import type { AgentGroupBlock } from "../../../infra/output-blocks.js";
import type { ToolHistorySummary } from "../../module-seams.js";

/** A call that addresses a child session: the parent's dispatch, its
 *  `process` control of the child, or a retired `subagent` resume or retry.
 *  `target` is the child's session link. */
export interface ChildCall {
  readonly kind: "dispatch" | "resume" | "retry" | "interrupt" | "stop";
  readonly target?: string;
}

/** The child call that a tool call makes, if any. A dispatch, a resume, and
 *  a retry own subagent cards; an interrupt and a stop settle with them. */
export function childCall(part: { readonly name: string; readonly input: { readonly [key: string]: unknown } }): ChildCall | undefined {
  const name = canonicalize(part.name);
  const input = part.input;
  if (name === "subagent") {
    // Retired call shapes: `subagent` resumed and retried a child before
    // `process` did, and recorded calls still render. Remove `resume`,
    // `retry`, and `session_id` here after 2027-04-08.
    const kind = input.kind === "resume" || input.kind === "retry" ? input.kind : "dispatch";
    return { kind, ...(typeof input.session_id === "string" ? { target: `flywheel://session/${input.session_id}` } : {}) };
  }
  if (name !== "process" || typeof input.process_id !== "string") return undefined;
  const action = input.action;
  return action === "resume" || action === "interrupt" || action === "stop"
    ? { kind: action, target: `flywheel://session/${input.process_id}` }
    : undefined;
}

/** Whether a child call owns a subagent card: a dispatch, or a resume. */
export function ownsSubagentCard(call: ChildCall | undefined): boolean {
  return call !== undefined && call.kind !== "interrupt" && call.kind !== "stop";
}

export interface SubagentCardCall {
  readonly cardId: string;
  readonly toolUseId: string;
  readonly kind: unknown;
  readonly target?: string;
  readonly accepted: boolean;
}

export interface SubagentCardAssignment {
  readonly run: ToolHistorySummary;
  readonly ownsRun: boolean;
}

/** A settled Resume owns a new attempt. Same-run continuations transfer the
 * active card while keeping older cards interrupted. A person's Resume adds
 * no parent call, so the latest card follows that child's latest attempt. */
export function assignSubagentCards(
  calls: readonly SubagentCardCall[],
  summaries: ReadonlyMap<string, ToolHistorySummary>,
): ReadonlyMap<string, SubagentCardAssignment> {
  const assignments = new Map<string, SubagentCardAssignment>();
  const latestRunByTarget = new Map<string, ToolHistorySummary>();
  const ownerByRun = new Map<ToolHistorySummary, string>();

  for (const [index, call] of calls.entries()) {
    const ownRun = summaries.get(call.toolUseId);
    const latest = ownRun ?? (call.kind === "resume" && call.accepted && call.target ? latestRunByTarget.get(call.target) : undefined);
    if (!latest) continue;
    if (ownRun?.linkUri) latestRunByTarget.set(ownRun.linkUri, ownRun);
    const attempts = latest.attempts;
    const currentAttempt = attempts?.findIndex((attempt) => attempt.resumes.some((resume) => resume.toolUseId === call.toolUseId));
    if (call.kind === "resume" && attempts && currentAttempt === -1) continue;
    const laterResume = calls.slice(index + 1).find((candidate) =>
      candidate.kind === "resume" && candidate.accepted && candidate.target === latest.linkUri
      && attempts?.some((attempt) => attempt.resumes.some((resume) => resume.toolUseId === candidate.toolUseId)));
    const nextAttempt = laterResume ? attempts?.findIndex((attempt) => attempt.resumes.some((resume) => resume.toolUseId === laterResume.toolUseId)) : undefined;
    const sameRun = nextAttempt !== undefined && nextAttempt >= 0 && attempts?.[nextAttempt]?.resumes.some((resume) => resume.toolUseId === laterResume?.toolUseId && resume.sameRun);
    const selected = nextAttempt !== undefined && nextAttempt >= 0
      ? Math.max(currentAttempt ?? 0, sameRun ? nextAttempt : nextAttempt - 1, 0)
      : undefined;
    let run = latest;
    let identity = latest;
    for (const [attemptIndex, attempt] of (attempts ?? []).entries()) {
      if (attemptIndex === selected) run = attempt.summary;
      identity = attempt.summary;
    }
    // The newest summary is a decorated copy of its last attempt. Compare
    // the canonical attempt object so same-run Resume still transfers ownership.
    if (run !== latest) identity = run;
    const previousOwner = ownerByRun.get(identity);
    if (previousOwner) assignments.set(previousOwner, { run, ownsRun: false });
    assignments.set(call.cardId, { run, ownsRun: true });
    ownerByRun.set(identity, call.cardId);
  }

  return assignments;
}

/** A card superseded by a same-run continuation keeps its figures but
 * shows interrupted. Settled attempts remain owned by their own cards. */
export function ownSubagentCard(card: AgentGroupBlock, assignment: SubagentCardAssignment | undefined): AgentGroupBlock {
  if (!assignment || assignment.ownsRun) return card;
  if (card.status === "error") {
    const { failure: _failure, ...rest } = card;
    return { ...rest, status: "interrupted" };
  }
  if (card.status === "paused") {
    const { pausedBy: _pausedBy, ...rest } = card;
    return { ...rest, status: "interrupted" };
  }
  return { ...card, status: "interrupted" };
}
