/**
 * PermissionRequest hook body — shared between the standalone `hook.ts`
 * entry (dev fallback) and the `ask-hook` subcommand shipped via our main
 * CLI binary. Reads JSON from stdin, bridges through FLYWHEEL_ASK_SOCKET
 * to the TUI, prints a PreToolUse decision on stdout.
 */
import net from "node:net";

interface HookInput {
  tool_name: string;
  tool_input: { questions?: unknown[] };
  tool_use_id?: string;
}

type HookResponse =
  | { answers: Record<string, string> }
  | { cancelled: true; message?: string };

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function emitAllow(updatedInput: Record<string, unknown>): void {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  });
}

function emitDeny(message: string): void {
  emit({
    decision: "block",
    reason: message,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
    },
  });
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk.toString("utf8");
  return data;
}

/** Safety cap so a wedged TUI (server alive, no user) can't block Claude forever. */
const BRIDGE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

type BridgeOutcome =
  | { kind: "ok"; response: HookResponse }
  | { kind: "fail"; message: string };

function bridge(socketPath: string, input: HookInput): Promise<BridgeOutcome> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (outcome: BridgeOutcome) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* ignore */ }
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({ kind: "fail", message: `Ask-hook timed out after ${Math.round(BRIDGE_TIMEOUT_MS / 1000)}s` });
    }, BRIDGE_TIMEOUT_MS);
    timer.unref?.();

    client.on("connect", () => {
      const message = JSON.stringify({
        type: "question",
        toolUseId: input.tool_use_id ?? "",
        questions: input.tool_input.questions ?? [],
      }) + "\n";
      client.write(message);
    });

    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      clearTimeout(timer);
      try {
        finish({ kind: "ok", response: JSON.parse(line) as HookResponse });
      } catch (err) {
        finish({ kind: "fail", message: `Ask-hook got malformed response: ${err instanceof Error ? err.message : String(err)}` });
      }
    });

    // Socket doesn't exist / server not listening / mid-flight error:
    // turn into a clean deny so Claude gets a decision instead of a crash.
    client.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const message = err.code === "ENOENT" || err.code === "ECONNREFUSED"
        ? "TUI not available for AskUserQuestion (no listener)"
        : `Ask-hook socket error: ${err.message}`;
      finish({ kind: "fail", message });
    });

    client.on("close", () => {
      clearTimeout(timer);
      if (!buffer.trim()) {
        finish({ kind: "fail", message: "Ask-hook socket closed without response" });
      }
    });
  });
}

export async function runAskHook(): Promise<void> {
  const raw = await readStdin();
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    emitDeny("Malformed hook input");
    return;
  }

  if (input.tool_name !== "AskUserQuestion") {
    return; // Not ours — empty stdout, default handling takes over
  }

  const socketPath = process.env.FLYWHEEL_ASK_SOCKET;
  if (!socketPath) {
    emitDeny("No TUI listener configured for AskUserQuestion");
    return;
  }

  const outcome = await bridge(socketPath, input);
  if (outcome.kind === "fail") {
    emitDeny(outcome.message);
    return;
  }
  const { response } = outcome;
  if ("cancelled" in response) {
    emitDeny(response.message ?? "User cancelled");
  } else {
    emitAllow({ ...input.tool_input, answers: response.answers });
  }
}
