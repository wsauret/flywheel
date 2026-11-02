import { type PresentationChannel, type PresentationIdOn, presentationChannel } from "./error-presentation.js";

type SessionNoticeSeverity = "info" | "warning" | "error";

/** The registered presentation families a notice may carry. A transcript
 *  presentation is a durable chat entry, never a notice, so it is excluded
 *  here by construction: a producer cannot raise a notice for a family the
 *  registry routes to the transcript. */
type SessionNoticePresentation = PresentationIdOn<Exclude<PresentationChannel, "transcript">>;

interface SessionNoticeAction {
  label: string;
  command?: string;
}

interface SessionNoticeRetry {
  count: number;
  maxRetries?: number;
  delayMs?: number;
  nextAttemptAt?: number;
}

/** A wait that ends on its own at a stated time, such as a wait for model
 *  capacity: it is no retry, and it has no count. */
interface SessionNoticeWait {
  agentName: string;
  continuesAt: number;
}

export interface SessionNotice {
  id: string;
  scope: string;
  /** Which registered family this notice belongs to. The channel it renders
   *  on derives from the registry through `sessionNoticeChannel`; nothing
   *  else decides the surface. */
  presentation: SessionNoticePresentation;
  severity: SessionNoticeSeverity;
  title: string;
  message: string;
  startedAt: number;
  updatedAt: number;
  retry?: SessionNoticeRetry;
  wait?: SessionNoticeWait;
  action?: SessionNoticeAction;
}

/** The one channel this notice renders on, as the registry states it. */
export function sessionNoticeChannel(notice: Pick<SessionNotice, "presentation">): Exclude<PresentationChannel, "transcript"> {
  return presentationChannel(notice.presentation);
}

type SessionNoticeInput = Omit<SessionNotice, "startedAt" | "updatedAt"> & {
  startedAt?: number;
  updatedAt?: number;
};

export type SessionNoticeOperation =
  | { type: "upsert"; notice: SessionNoticeInput }
  | { type: "resolve"; id: string }
  | { type: "resolve-scope"; scope: string };

const MAX_NOTICES = 8;

export function applySessionNoticeOperation(
  current: readonly SessionNotice[],
  operation: SessionNoticeOperation,
  now = Date.now(),
): readonly SessionNotice[] {
  switch (operation.type) {
    case "upsert":
      return upsertSessionNotice(current, operation.notice, now);
    case "resolve":
      return removeNotices(current, (notice) => notice.id === operation.id);
    case "resolve-scope":
      return removeNotices(current, (notice) => notice.scope === operation.scope);
  }
}

/** Returns `current` itself when nothing matches. A resolution for a notice
 *  that is not raised is the common case (every healthy request resolves its
 *  provider scope), and a new array there would read as a state change and mint
 *  an empty patch downstream. */
function removeNotices(
  current: readonly SessionNotice[],
  matches: (notice: SessionNotice) => boolean,
): readonly SessionNotice[] {
  const next = current.filter((notice) => !matches(notice));
  return next.length === current.length ? current : next;
}

function upsertSessionNotice(
  current: readonly SessionNotice[],
  input: SessionNoticeInput,
  now = Date.now(),
): readonly SessionNotice[] {
  const prior = current.find((notice) => notice.id === input.id);
  const next: SessionNotice = {
    ...input,
    startedAt: input.startedAt ?? prior?.startedAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  const rest = current.filter((notice) => notice.id !== input.id && notice.scope !== input.scope);
  return [...rest, next]
    .sort((a, b) => noticePriority(b) - noticePriority(a) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_NOTICES);
}

export function selectPrimarySessionNotice(notices: readonly SessionNotice[]): SessionNotice | null {
  return notices.reduce<SessionNotice | null>((best, notice) => {
    if (!best) return notice;
    const priority = noticePriority(notice);
    const bestPriority = noticePriority(best);
    if (priority !== bestPriority) return priority > bestPriority ? notice : best;
    return notice.updatedAt > best.updatedAt ? notice : best;
  }, null);
}

function noticePriority(notice: SessionNotice): number {
  // A standing action-needed notice outranks a passing toast, which outranks
  // in-flight status progress.
  const channel = sessionNoticeChannel(notice);
  const standing = channel === "toast" ? 500 : 0;
  const severity = notice.severity === "error" ? 100 : notice.severity === "warning" ? 50 : 0;
  const action = notice.action ? 10 : 0;
  const retry = notice.retry || notice.wait ? 5 : 0;
  return standing + severity + action + retry;
}

export function noticeText(notice: SessionNotice): string {
  const action = notice.action ? ` ${notice.action.label}${notice.action.command ? `: ${notice.action.command}` : ""}.` : "";
  return `${notice.title}. ${notice.message}${action}`;
}
