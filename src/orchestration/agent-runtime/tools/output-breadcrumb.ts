/**
 * Truncation breadcrumb for tool results.
 *
 * When a tool drops information to fit within a self-imposed result limit
 * (e.g. search capping at N matches), it
 * should still hand the model a path to recover the dropped data.
 *
 * `saveFullOutput` redacts the payload and hands it to the session artifact
 * owner, which places it at
 * `.flywheel/agent-outputs/<artifactScopeId>/<toolName>_<ts>_<id>.txt`. The
 * caller appends the returned path to its truncated output so the
 * model can `read` it with offset/limit.
 *
 * Breadcrumbs are swept by age, project-wide, so callers do not track files
 * individually and a resumed session can still read one written by an earlier
 * runner (see `session/session-artifacts.ts`).
 */

import { errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { redactSecretsWork } from "../../../infra/redact-secrets.js";
import { runInTaskSlices } from "../../../infra/task-scheduling.js";
import { writeArtifactBreadcrumb } from "../../session/session-artifacts.js";

const log = Log.create({ service: "agent-output-breadcrumb" });

/** Write failures that mean the machine cannot take the file right now: a full
 *  disk, an exhausted quota, a read-only or unwritable mount, no descriptors
 *  left. The tool call still owns its truncated answer, so the breadcrumb is
 *  what gives way. Every other failure - a session id that is not one path
 *  component, a component of the tree replaced by a link - is a defect or an
 *  attack, and is raised. */
const RECOVERABLE_WRITE_CODES = new Set(["EACCES", "EDQUOT", "EIO", "EMFILE", "ENFILE", "ENOSPC", "EPERM", "EROFS"]);

/**
 * Save full content to the session's breadcrumb directory and return the
 * absolute path. Returns null when the write failed recoverably; callers then
 * degrade to producing the truncated output without a breadcrumb rather than
 * failing the whole tool call. The content can hold megabytes of tool output,
 * so its redaction runs in task slices.
 */
export async function saveFullOutput(
  content: string,
  toolName: string,
  projectRoot: string,
  artifactScopeId: string,
): Promise<string | null> {
  // Single redaction + permission boundary for the disk breadcrumb. The model
  // recovers this file via a read tool (which re-enters pushMessage and is masked
  // there too), but the on-disk artifact must not hold the raw secret, and must
  // not be world-readable. The breadcrumb is a durable egress (ARCH-BOUNDARIES-010).
  const redacted = await runInTaskSlices("output-breadcrumb:redact", redactSecretsWork(content));
  try {
    return writeArtifactBreadcrumb({ projectRoot, artifactScopeId, toolName, content: redacted });
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
    if (typeof code !== "string" || !RECOVERABLE_WRITE_CODES.has(code)) throw err;
    log.warn("failed to save full output", { toolName, artifactScopeId, code, error: errorMessage(err) });
    return null;
  }
}
