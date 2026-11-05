import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { FileSink } from "bun";
import type { StopHold } from "./stop-hold.js";
import type { LauncherScope, OwnershipClosure } from "./process-supervisor.js";
import { launchFailed, type OwnedProcess, type OwnedProcessExit } from "./owned-subprocess.js";

/** The longest stderr line the sink receives. Most of the CLI's debug lines are
 *  short, but an HTTP error line holds the whole response body, which the bridge
 *  passes on as the request's failure. A longer line is cut so that one runaway
 *  line cannot grow host memory. */
const MAX_STDERR_LINE_CHARS = 1_048_576;

type ProcessListener = ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void);

/** One CLI launch through Flywheel's launch authority (ARCH-TOOLS-022). */
export interface OwnedClaudeProcess {
  /** The `spawnClaudeCodeProcess` function for exactly one query. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Settles when the launched container has exited, or with `undefined` when
   *  no launch happened or the launch authority refused it. It settles after
   *  `cannotStart` states the exit. */
  exited(): Promise<OwnedProcessExit | undefined>;
  /** Whether a launched container is still running. */
  running(): boolean;
  /** Whether the engine exited because it could not start (`launchFailed`):
   *  it is missing, it is not executable, or it is built for another C
   *  library. It is set before the SDK sees the exit, so the reader of the
   *  SDK's error can read it. Another start of the same engine fails the same
   *  way. */
  cannotStart(): boolean;
  /** Ends the container through its supervisor: the stop hold, TERM, grace, then KILL. */
  terminate(): Promise<void>;
  /** Closes the nested launch scope, which ends anything it still holds. */
  close(): Promise<OwnershipClosure>;
}

/**
 * Builds the SDK spawn seam over one nested scope of `parent`, so the CLI is
 * an owned container: it ends with the scope, with the runtime generation, and
 * with a host crash (the guardian), and `lint:owned-processes` sees no raw
 * launch.
 *
 * The SDK calls the seam synchronously and `spawnOwned` is asynchronous, so the
 * returned process buffers stdin writes and kill requests until the container
 * exists. stdout is piped to a Node stream because the SDK reads it with
 * readline. stderr is always drained, because Bun buffers an unread pipe
 * without a bound; each complete line goes to `onStderrLine`.
 *
 * The SDK calls the seam once for each query, so one value serves one query.
 *
 * A launch on a Claude login declares `stopHold`, the login's token-refresh lock, so no end of
 * the CLI signals it while a refresh holds the login (bridge rule 3): the
 * SDK's own kill, this seam's `terminate`, the close of the nested scope or of
 * any scope above it, the end of the runtime generation, and the guardian's
 * sweep after a host crash all end the container through the launch
 * authority, which honors the hold. An engine with no login, such as the MCP
 * engine, has no such lock and declares none.
 */
export function ownedClaudeProcess(parent: LauncherScope, onStderrLine: (line: string) => void, stopHold: StopHold | undefined): OwnedClaudeProcess {
  const scope = parent.open();
  let launched: Promise<OwnedProcess | undefined> | undefined;
  let alive = false;
  /** The container's exit once the seam has read it, which `exited` waits for. */
  let ended: OwnedProcessExit | undefined;
  const settled = Promise.withResolvers<OwnedProcessExit | undefined>();

  const spawn = (options: SpawnOptions): SpawnedProcess => {
    // oxlint-disable-next-line unicorn/prefer-event-target -- boundary: the SDK's SpawnedProcess contract is Node's ChildProcess listener API
    const events = new EventEmitter();
    const stdout = new PassThrough();
    let input: FileSink | undefined;
    let killed = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    const ready = scope.spawnOwned([options.command, ...options.args], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: options.env, ...(stopHold === undefined ? {} : { stopHold }) });
    launched = ready.then((owned) => owned, () => undefined);

    /** Connects the container's pipes, then reports its exit. Node buffers
     *  stdin writes until `connected` runs, which is the stream's construct
     *  callback. */
    const attach = async (connected: () => void): Promise<void> => {
      let owned: OwnedProcess;
      try {
        owned = await ready;
      } catch (error) {
        // The process error event carries the failure, so stdin accepts and
        // drops what the SDK still writes instead of raising a second error.
        connected();
        stdout.end();
        settled.resolve(undefined);
        events.emit("error", error instanceof Error ? error : new Error(String(error)));
        return;
      }
      alive = true;
      input = owned.stdin;
      connected();
      if (owned.stdout) void pipeStdout(owned.stdout, stdout);
      else stdout.end();
      if (owned.stderr) void drainLines(owned.stderr, onStderrLine);
      const exit = await owned.exited;
      alive = false;
      ended = exit;
      settled.resolve(exit);
      exitCode = exit.signal === null ? exit.code : null;
      signalCode = exit.signal;
      events.emit("exit", exitCode, signalCode);
    };

    const stdin = new Writable({
      construct(connected) {
        void attach(connected);
      },
      write(chunk: Buffer, _encoding, done) {
        try {
          input?.write(chunk);
          void input?.flush();
          done();
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      },
      final(done) {
        try {
          void input?.end();
        } catch {
          // The CLI can close its stdin before its exit is observed.
        }
        done();
      },
    });
    const kill = (): void => {
      killed = true;
      // The stop hold, TERM, grace, and KILL belong to the container's
      // supervisor, so the requested signal name is advisory.
      void ready.then((owned) => owned.terminate(), () => undefined);
    };
    // The SDK aborts this forwarded signal only after its own graceful-close
    // window (stdin EOF, then about 2 s).
    options.signal.addEventListener("abort", kill, { once: true });

    return {
      stdin,
      stdout,
      get killed() { return killed; },
      get exitCode() { return exitCode; },
      get signalCode() { return signalCode; },
      kill() { kill(); return true; },
      on(event: "exit" | "error", listener: ProcessListener) { events.on(event, listener); },
      once(event: "exit" | "error", listener: ProcessListener) { events.once(event, listener); },
      off(event: "exit" | "error", listener: ProcessListener) { events.off(event, listener); },
    };
  };

  return {
    spawn,
    exited: async () => launched === undefined ? undefined : await settled.promise,
    running: () => alive,
    cannotStart: () => ended !== undefined && launchFailed(ended),
    terminate: async () => {
      const owned = await launched;
      if (owned !== undefined) await owned.terminate();
    },
    close: () => scope.close(),
  };
}

/** Copies the CLI's stdout into the Node stream the SDK reads, honoring the
 *  reader's backpressure, and ends it with the pipe. */
async function pipeStdout(stream: ReadableStream<Uint8Array>, out: PassThrough): Promise<void> {
  try {
    for await (const chunk of stream) {
      if (!out.write(chunk)) await once(out, "drain");
    }
  } catch {
    // The pipe ends with the container; its exit status carries the outcome.
  }
  out.end();
}

async function drainLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        onLine(pending.slice(0, Math.min(newline, MAX_STDERR_LINE_CHARS)));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_STDERR_LINE_CHARS) pending = pending.slice(0, MAX_STDERR_LINE_CHARS);
    }
    pending += decoder.decode();
  } catch {
    // The pipe ends with the container; a read error carries no signal the
    // exit status does not.
  }
  if (pending.length > 0) onLine(pending.slice(0, MAX_STDERR_LINE_CHARS));
}
