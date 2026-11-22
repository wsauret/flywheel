import { createHash } from "node:crypto";
import { Log } from "../../../infra/log.js";
import { ContextLengthExceededError, LlmStreamError, RouteUnavailableError } from "../../agent-runtime/llm/errors.js";
import { classifyGoogleError } from "../../agent-runtime/llm/google-errors.js";
import { ProviderAuthenticationError } from "../../agent-runtime/llm/provider-failure.js";
import type { AcpCloseReason, AcpRequestError } from "./acp/connection.js";

const log = Log.create({ service: "provider-google-antigravity" });

/** The JSON-RPC error code with which agy refuses a request because its home holds no usable login
 *  (`Authentication required`). */
const ACP_AUTHENTICATION_REQUIRED = -32000;

const LOGIN_COMMAND = "flywheel auth login --google-antigravity";

/** Google requires a person to verify the signed-in account in a browser before any model answers it. agy states it
 *  only as the text `Verification Required` (log: `PERMISSION_DENIED (code 403) ... VALIDATION_REQUIRED`), and the
 *  verification link reaches only agy's log. It is a login problem that only the person can clear, so the walk does
 *  not retry it. */
export class AccountVerificationRequiredError extends ProviderAuthenticationError {
  constructor() {
    super("Google requires verification of this Antigravity account before it serves requests. Sign in to the account in a browser and complete Google's verification, then try again.");
    this.name = "AccountVerificationRequiredError";
  }
}

/** agy reports a failed prompt turn as one `agent_message_chunk` of the form `"\n⚠ <detail>\n"`, then ends the turn
 *  with `end_turn` (agy 1.5.14). */
const ENGINE_NOTICE = /^\n⚠ ([\s\S]+?)\n?$/u;

/** The detail of an agy failure notice, or undefined when `text` is not one. */
export function engineNoticeDetail(text: string): string | undefined {
  return ENGINE_NOTICE.exec(text)?.[1];
}

/** The Gemini API error inside agy's text, as Go's client prints it: `Error 429, Message: <message>, Status:
 *  RESOURCE_EXHAUSTED, Details: [...]` in a notice and in a `Run: attempt N failed (...)` log line. */
const SERVICE_ERROR = /Error (\d{3}), Message: [\s\S]*$/u;
/** The same error in agy's error-report form: `PERMISSION_DENIED (code 403): Verify your account to continue.` */
const SERVICE_STATUS = /[A-Z_]+ \(code (\d{3})\): [\s\S]*$/u;

/** A Gemini API error that agy relayed as text: the message is the API's own error text, and `status` its HTTP status. */
class EngineServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "EngineServiceError";
  }
}

/**
 * The typed failure of a prompt turn that agy ended with a failure notice, from the notice's detail
 * (`engineNoticeDetail`) or the error text of agy's log. A known text is the failure that native Flywheel raises for
 * the same Gemini response, so the walk retries, fails over, or compacts the same way on both routes. An unknown text,
 * also a Gemini API error whose status no rule names, is a provider failure, never a success. Its error holds none of the
 * text, because the runtime's diagnostics and audit serialize the error, and its record holds only the text's hash and
 * size.
 */
export function engineFailure(detail: string): Error {
  if (detail === "Verification Required" || /VALIDATION_REQUIRED|Verify your account/u.test(detail)) {
    return new AccountVerificationRequiredError();
  }
  // agy refuses a session whose system text leaves no room in the model's window, and sends no request.
  if (/maxMessageTokens must be positive/u.test(detail)) return new ContextLengthExceededError(`Google Antigravity: ${detail}`);
  const service = SERVICE_ERROR.exec(detail) ?? SERVICE_STATUS.exec(detail);
  if (service !== null) {
    const error = new EngineServiceError(service[0], Number(service[1]));
    const classified = classifyGoogleError(error, () => error.status);
    if (classified !== error) return classified;
  }
  log.warn("Google Antigravity reported an unknown failure", { sha256: createHash("sha256").update(detail).digest("hex"), bytes: Buffer.byteLength(detail) });
  return new LlmStreamError("Google Antigravity reported a failure that Flywheel does not recognize", "unknown");
}

/** The failure of a request that agy answered with a JSON-RPC error. */
export function acpRequestFailure(error: AcpRequestError): Error {
  if (error.code === ACP_AUTHENTICATION_REQUIRED) {
    return new ProviderAuthenticationError(`Google Antigravity is not signed in (${error.message}). Run: ${LOGIN_COMMAND}`, { cause: error });
  }
  return new LlmStreamError(error.message, "unknown", undefined, { cause: error });
}

/** The failure of a request whose engine connection ended (`reason`) before the request settled. Before the request's
 *  first model frame (`responded`), the route could not serve it, and the walk tries the next candidate; after it, the
 *  response was cut, as when a network stream tears. */
export function engineStoppedFailure(reason: AcpCloseReason, responded: boolean): Error {
  return responded
    ? new LlmStreamError(`The Google Antigravity engine stopped during the response (${reason.kind})`, "transient")
    : new RouteUnavailableError(`The Google Antigravity engine stopped before it answered the request (${reason.kind})`);
}
