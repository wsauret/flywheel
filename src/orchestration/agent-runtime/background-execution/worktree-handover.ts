/**
 * Carries a conversation's record of the worktrees its commands created
 * across a planned replacement (ARCH-TOOLS-060), beside the commands that
 * cross it (ARCH-RUNTIME-033). A replacement can continue the same logical
 * turn, so a record that ended with the build would let a worktree pass the
 * turn end without its reminder.
 *
 * The host that closes for the replacement writes one in-flight row for its
 * conversation, and a host of that conversation in the next build takes it
 * over and retires it by compare-and-swap. The executor's keeper runs no turn,
 * so it leaves the row for the conversation's host.
 */

import { errorMessage } from "../../../infra/diagnostics/error-message.js";
import { isRecord } from "../../../infra/guards/record.js";
import { Log } from "../../../infra/diagnostics/log.js";
import type { CreatedWorktree } from "../tools/bash/git/created-worktrees.js";
import type { CommandHandoverHost, CommandHandoverScope } from "./command-handover.js";

const log = Log.create({ service: "command-handover" });

export const CREATED_WORKTREES_IN_FLIGHT_KIND = "session.created_worktrees";

/** Writes the record for the next build, when this host closes for a heard
 *  handoff and its commands created a worktree. Never rejects: a record that
 *  cannot be written costs only the reminder. */
export async function handOverCreatedWorktrees(host: CommandHandoverScope, worktrees: readonly CreatedWorktree[]): Promise<void> {
  if (worktrees.length === 0 || host.authority.handoffId() === undefined) return;
  try {
    await host.authority.writer.putInFlight(host.sessionId, CREATED_WORKTREES_IN_FLIGHT_KIND, host.conversationId, { version: 1, conversationId: host.conversationId, worktrees });
    log.info("handed the created-worktree record to the next build", { sessionId: host.sessionId, conversationId: host.conversationId, count: worktrees.length });
  } catch (err) {
    log.warn("the created-worktree record could not be handed to the next build", { sessionId: host.sessionId, error: errorMessage(err) });
  }
}

/** Takes over the record that a previous build handed to this host's
 *  conversation, once. A row this release cannot read is reported and left in
 *  place for a build that can. Never rejects. */
export async function adoptCreatedWorktrees(host: CommandHandoverHost, adopt: (worktrees: readonly CreatedWorktree[]) => void): Promise<void> {
  if (host.holder !== "conversation") return;
  try {
    const { projectionReader, writer } = host.authority;
    const stored = (await projectionReader.readInFlight(host.sessionId, CREATED_WORKTREES_IN_FLIGHT_KIND, host.conversationId)).find((record) => record.key === host.conversationId);
    if (stored === undefined) return;
    const worktrees = decodeWorktrees(stored.payload, host.conversationId);
    if (worktrees === undefined) {
      log.warn("a created-worktree record has a shape this release cannot read; it is left in place", { sessionId: host.sessionId, version: String(stored.payload.version) });
      return;
    }
    if (!await writer.swapInFlight(host.sessionId, CREATED_WORKTREES_IN_FLIGHT_KIND, host.conversationId, stored.raw, null)) return;
    adopt(worktrees);
    log.info("adopted the created-worktree record of a previous build", { sessionId: host.sessionId, conversationId: host.conversationId, count: worktrees.length });
  } catch (err) {
    log.warn("the created-worktree record could not be read; it is left for a later host", { sessionId: host.sessionId, error: errorMessage(err) });
  }
}

/** Reads one row strictly as version 1, or answers undefined. */
function decodeWorktrees(payload: { readonly [key: string]: unknown }, conversationId: string): readonly CreatedWorktree[] | undefined {
  const { version, worktrees } = payload;
  if (version !== 1 || payload.conversationId !== conversationId || !Array.isArray(worktrees) || Object.keys(payload).length !== 3) return undefined;
  const decoded: CreatedWorktree[] = [];
  const entries: readonly unknown[] = worktrees;
  for (const entry of entries) {
    if (!isRecord(entry)) return undefined;
    const { path, reminded } = entry;
    if (typeof path !== "string" || path.length === 0 || typeof reminded !== "boolean") return undefined;
    decoded.push({ path, reminded });
  }
  return decoded;
}
