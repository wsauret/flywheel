import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DebugLog } from "../../../infra/debug-log.js";
import type { OwnedClaudeProcess } from "../../../infra/claude-engine-process.js";
import { debugLineReader, signInTrace, type DebugLine } from "./stderr-signals.js";

/** What the owner of one engine hears of it, each in the order in which the engine wrote it. Each call returns at
 *  once. */
export interface EngineObserver {
  /** One message of the engine's SDK stream. */
  readonly message: (message: SDKMessage) => void;
  /** The SDK stream ended, which it does when the engine's process ends: with the stream's failure, such as the SDK's
   *  report that the process exited, or with undefined. It is the observer's last call. */
  readonly ended: (error: unknown) => void;
  /** One line of the engine's debug output that tells Flywheel something (`debugLineReader`). */
  readonly debugLine?: (line: DebugLine) => void;
}

/** The launch facts of one engine for its launch record: its role, its session id, and what its owner adds. Ids,
 *  counts, and model names only, never content. */
export interface EngineLaunchRecord {
  readonly role: "chat" | "host";
  readonly sessionId: string;
  readonly [fact: string]: string | number | boolean;
}

/** One engine process, observed from its launch. */
export interface ObservedEngine<Launched> {
  readonly launched: Launched;
  /** The engine's sign-in lines since its launch. */
  readonly signIn: ReturnType<typeof signInTrace>;
}

/**
 * Launches one engine and observes it from that moment: the stderr reader reads every line from the launch on, and
 * one SDK reader reads `stream(launched)` from the launch on until the stream ends, so the owner hears the end of an
 * engine that never served a request, such as a pre-started one, the moment its process ends. A pre-started engine
 * and a serving engine are two phases of the one engine that this observes; neither phase adds an observer. The
 * launch is recorded once. `launch` throws when the engine cannot be launched, and then nothing is observed or
 * recorded.
 */
export function observeEngine<Launched extends { readonly process: OwnedClaudeProcess }>(
  launch: (onStderrLine: (line: string) => void) => Launched,
  stream: (launched: Launched) => AsyncIterable<SDKMessage>,
  observer: EngineObserver,
  record: EngineLaunchRecord,
): ObservedEngine<Launched> {
  const signIn = signInTrace();
  const sorted = observer.debugLine === undefined ? undefined : debugLineReader(observer.debugLine);
  const launched = launch((line) => {
    signIn.read(line);
    sorted?.(line);
  });
  DebugLog.record({ type: "provider.claude_sdk.engine.launched", payload: record });
  void read(stream(launched), observer);
  return { launched, signIn };
}

async function read(stream: AsyncIterable<SDKMessage>, observer: EngineObserver): Promise<void> {
  let failure: unknown;
  try {
    for await (const message of stream) observer.message(message);
  } catch (error) {
    failure = error;
  }
  observer.ended(failure);
}
