/**
 * Unix-socket server that bridges AskUserQuestion between Claude's
 * PermissionRequest hook and our TUI dock.
 *
 * Claude's CLI auto-denies AskUserQuestion under --dangerously-skip-permissions
 * because the tool's requiresUserInteraction() short-circuits the bypass path
 * (see inspiration/claude-code/src/utils/permissions/permissions.ts:1230-1236).
 * The escape hatch is a PermissionRequest hook: the hook runs as a child of
 * the CLI, and if it returns an allow decision with updatedInput.answers,
 * Claude uses those answers as the tool result.
 *
 * Wire format, newline-delimited JSON:
 *   hook → server:  { type: "question", toolUseId, questions }
 *   server → hook:  { answers }  |  { cancelled: true, message? }
 */
import net from "node:net";
import { unlink } from "node:fs/promises";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";

const log = Log.create({ service: "ask-hook-server" });

interface PendingHook {
  socket: net.Socket;
  resolved: boolean;
}

export interface AskHookServer {
  readonly socketPath: string;
  /** Resolve the pending hook for this toolUseId by sending answers back. */
  deliver(toolUseId: string, answers: Record<string, string>): boolean;
  /** Cancel the pending hook for this toolUseId. Tells Claude the user declined. */
  cancel(toolUseId: string, message?: string): boolean;
  /** Close server and cancel all pending hooks. */
  close(): Promise<void>;
}

export async function createAskHookServer(socketPath: string): Promise<AskHookServer> {
  try { await unlink(socketPath); } catch { /* no stale socket */ }

  const pending = new Map<string, PendingHook>();

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          try {
            const msg = JSON.parse(line) as { type?: string; toolUseId?: string };
            if (msg.type === "question" && typeof msg.toolUseId === "string") {
              pending.set(msg.toolUseId, { socket, resolved: false });
              log.info("hook registered", { toolUseId: msg.toolUseId });
            }
          } catch (err) {
            log.warn("hook sent malformed line", { error: errorMessage(err) });
          }
        }
        idx = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      for (const [key, value] of pending) {
        if (value.socket === socket) pending.delete(key);
      }
    });
    socket.on("error", (err) => {
      log.warn("hook socket error", { error: err.message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  function respond(toolUseId: string, payload: Record<string, unknown>): boolean {
    const entry = pending.get(toolUseId);
    if (!entry || entry.resolved) return false;
    entry.resolved = true;
    try {
      entry.socket.write(JSON.stringify(payload) + "\n");
      entry.socket.end();
    } catch (err) {
      log.warn("failed to respond to hook", { toolUseId, error: errorMessage(err) });
    }
    pending.delete(toolUseId);
    return true;
  }

  return {
    socketPath,
    deliver(toolUseId, answers) {
      return respond(toolUseId, { answers });
    },
    cancel(toolUseId, message = "User cancelled") {
      return respond(toolUseId, { cancelled: true, message });
    },
    async close() {
      for (const [toolUseId] of pending) {
        respond(toolUseId, { cancelled: true, message: "Session ended" });
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { await unlink(socketPath); } catch { /* already gone */ }
    },
  };
}
