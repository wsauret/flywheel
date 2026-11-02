import { errorMessage } from "../infra/error-message.js";
import { readExecutionEvidence } from "../orchestration/session/execution-evidence.js";

const USAGE = "Usage: flywheel events evidence --session <id> [--project-root <dir>]\n\nPrint read-only durable execution evidence as JSON v1.\nPrices are estimates; provider-invoiced cost is unavailable.";

/** Emits JSON v1 for one durable session tree. The root argument parser owns
 * --project-root. Invalid arguments or unavailable evidence set exit code 1. */
export async function runEventEvidence(args: readonly string[], projectRoot: string): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE);
    return;
  }
  let sessionId: string | undefined;
  try {
    const argumentsIterator = args.values();
    for (const arg of argumentsIterator) {
      if (arg !== "--session" && !arg.startsWith("--session=")) throw new Error(`Unknown option: ${arg}`);
      if (sessionId !== undefined) throw new Error("--session may be given once");
      const value = arg === "--session" ? argumentsIterator.next().value : arg.slice("--session=".length);
      if (!value || value.startsWith("-")) throw new Error("--session requires a value");
      sessionId = value;
    }
    if (sessionId === undefined) throw new Error("--session is required");
    console.log(JSON.stringify(await readExecutionEvidence(projectRoot, sessionId)));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
