import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DebugLog } from "../../../infra/debug-log.js";
import { asRecord } from "../../../infra/record.js";
import { ProviderRequestValidationError } from "../../agent-runtime/llm/errors.js";
import { CLAUDE_AGENT_SDK_LABEL } from "./names.js";
import pluginManifest from "./step-gate-plugin/plugin.json" with { type: "json" };
import pluginHooks from "./step-gate-plugin/hooks/hooks.json" with { type: "json" };
import pluginHookModule from "./step-gate-plugin/hooks/register.js.txt";

/** The plugin's manifest name. The CLI lists it in `system/init.plugins` when it loaded the plugin. */
export const STEP_GATE_PLUGIN = pluginManifest.name;
/** The plugin's own files by their path in the plugin folder, which each query's private copy holds. No query loads
 *  the source folder, because the CLI writes type files and a `tsconfig.json` into each plugin folder that it loads.
 *  The files reach the module through imports, which `Bun.build` inlines, because a compiled build has no folder
 *  beside its modules. The manifest's source sits at the top of the source folder, because a dev service's source
 *  snapshot skips every name that starts with a dot; only the copy holds the `.claude-plugin` folder that the CLI
 *  reads. The hook module's source ends in `.txt`, so Bun's text loader reads it by its extension:
 *  an import attribute on a `.js` path holds for an ESM import but not for a `require`, which would load the
 *  file as a module. */
const STEP_GATE_PLUGIN_FILES = {
  ".claude-plugin/plugin.json": JSON.stringify(pluginManifest),
  "hooks/hooks.json": JSON.stringify(pluginHooks),
  "hooks/register.js": pluginHookModule,
};
/** The CLI variable through which the plugin's hook finds the socket of its query. */
export const STEP_GATE_SOCKET_VARIABLE = "STEP_GATE_SOCKET";

/** What the plugin's hook states about one step: its turn, its position in that turn from 0, and how many messages
 *  it sends. */
export interface StepAsk {
  readonly turnId: string;
  readonly index: number;
  readonly messageCount: number;
}

/**
 * The step that one admission is for. A pushed message starts a new CLI turn, so its request is the first step of a
 * turn (`turn-start`). Results that parked handlers take continue the turn of the last admitted step, so their
 * request is that turn's next step (`continuation`). An in-place rotation that replays a conversation's opening row
 * writes it as a turn start, so that the CLI states its opening reminders after it, and the gate refuses that turn's
 * first step without a report (`replayed-turn-start`, in-place.ts): the step is the bridge's own and sends nothing.
 */
type StepAdmission = "turn-start" | "continuation" | "replayed-turn-start";

/**
 * The step admission of one query. The CLI fires the plugin's `turn.step` hook before every model request of a
 * turn, and the hook sends no request unless the bridge admits it. The bridge arms one admission for each Flywheel
 * request, when it pushes the request or hands the parked handlers their results, and the admission admits only the
 * step that the request starts. So every request that the CLI starts by itself (a nudge after an empty reply, a
 * resume after a cut or after `max_tokens`, an answer to tool input it cannot parse or to a tool-use stop without a
 * call) finds no admission and is never sent, also when it asks while Flywheel's next request waits.
 */
export interface StepGate {
  /** Admits the CLI's next step of the given kind once. */
  arm(admission: StepAdmission): void;
  /** Whether the armed admission is still unused. A request that streams while it is unused never passed the gate. */
  armed(): boolean;
  /** Answers one ask of the hook: true for the step that the armed admission is for, which uses it up, and false
   *  otherwise. A replayed turn start's step uses its admission up and is refused without a report. */
  ask(step: StepAsk): boolean;
  /** Refuses every later ask. */
  close(): void;
}

/** Builds the admission of one query. `onRefused` hears each refused step; it must return at once. */
export function createStepGate(onRefused: (step: StepAsk) => void): StepGate {
  let admission: StepAdmission | undefined;
  let closed = false;
  let admitted: StepAsk | undefined;
  const isAdmitted = (step: StepAsk): boolean => {
    if (admission === "turn-start") return step.index === 0 && step.turnId !== admitted?.turnId;
    return admission === "continuation" && admitted !== undefined && step.turnId === admitted.turnId && step.index === admitted.index + 1;
  };
  return {
    arm(kind) {
      admission = closed ? undefined : kind;
    },
    armed: () => admission !== undefined,
    ask(step) {
      if (admission === "replayed-turn-start" && step.index === 0 && step.turnId !== admitted?.turnId) {
        admission = undefined;
        return false;
      }
      if (isAdmitted(step)) {
        admission = undefined;
        admitted = step;
        return true;
      }
      onRefused(step);
      return false;
    },
    close() {
      closed = true;
      admission = undefined;
    },
  };
}

/** What one gate served, for the record of a stop that the gate decided: the asks that it answered, the requests
 *  that it could not read, and the byte length of its socket path, which a Unix socket limits. */
export interface StepGateEvidence {
  readonly asks: number;
  readonly rejected: number;
  readonly socketPathBytes: number;
}

/** The private directory of one gate: the socket on which its plugin's hook asks, and its copy of the plugin. */
export interface PluginGateServer {
  readonly socketPath: string;
  /** The plugin folder that the engine names in the SDK's documented `plugins` option. */
  readonly pluginPath: string;
  evidence(): StepGateEvidence;
  /** Stops answering and removes the directory, with what the CLI wrote into the plugin copy. */
  close(): void;
}

/** One gate's plugin and how it answers its hook. */
export interface PluginGate {
  /** The prefix of the gate's private directory. */
  readonly prefix: string;
  /** The plugin's files by their path in the copy. */
  readonly files: { readonly [path: string]: string };
  /** Records a request of `bytes` that the gate cannot read. */
  onRejected(bytes: number): void;
  /** The answer to one hook request: `path` names the hook's call and `body` is its parsed JSON, or undefined for
   *  text that is not JSON. Undefined refuses the request as one that the gate cannot read. The hook waits for an
   *  answer that is still a promise. */
  answer(path: string, body: unknown): object | Promise<object> | undefined;
}

/**
 * Serves a plugin gate on a Unix socket in a new private directory, which only this account can open, and copies the
 * plugin into the same directory. A request that the gate cannot read gets no admission and no ask, and records its
 * size.
 */
export function servePluginGate(gate: PluginGate): PluginGateServer {
  const directory = mkdtempSync(join(tmpdir(), gate.prefix));
  try {
    const pluginPath = join(directory, "plugin");
    for (const [file, text] of Object.entries(gate.files)) {
      mkdirSync(dirname(join(pluginPath, file)), { recursive: true });
      writeFileSync(join(pluginPath, file), text);
    }
    const socketPath = join(directory, "gate.sock");
    let asks = 0;
    let rejected = 0;
    const server = Bun.serve({
      unix: socketPath,
      fetch: async (request) => {
        const text = await request.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        const answer = await gate.answer(new URL(request.url).pathname, body);
        if (answer === undefined) {
          rejected += 1;
          gate.onRejected(Buffer.byteLength(text));
          return Response.json({ admit: false }, { status: 400 });
        }
        asks += 1;
        return Response.json(answer);
      },
    });
    return {
      socketPath,
      pluginPath,
      evidence: () => ({ asks, rejected, socketPathBytes: Buffer.byteLength(socketPath) }),
      close: () => {
        void server.stop(true);
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Serves the step gate of one query (`servePluginGate`). The hook's request is a JSON object with a string `turnId`
 * and a numeric `index` and `messageCount`.
 */
export function serveStepGate(gate: Pick<StepGate, "ask">): PluginGateServer {
  return servePluginGate({
    prefix: "step-gate-", files: STEP_GATE_PLUGIN_FILES,
    onRejected: (bytes) => { DebugLog.record({ type: "provider.claude_sdk.step_gate.rejected", payload: { bytes } }); },
    answer: (_path, body) => {
      const step = stepAsk(body);
      return step === undefined ? undefined : { admit: gate.ask(step) };
    },
  });
}

function stepAsk(parsed: unknown): StepAsk | undefined {
  const body = asRecord(parsed);
  const turnId = body?.["turnId"];
  const index = body?.["index"];
  const messageCount = body?.["messageCount"];
  return typeof turnId === "string" && typeof index === "number" && typeof messageCount === "number" ? { turnId, index, messageCount } : undefined;
}

/** Why the gate does not hold for a query. */
export type StepGateFault =
  /** `system/init.plugins` does not list the plugin. */
  | "plugin-not-loaded"
  /** A model request streamed while its admission was unused, so the plugin's hook did not run. */
  | "step-not-asked"
  /** The CLI ended a completed turn while its admission was unused: the hook refused Flywheel's own step because it
   *  could not ask the gate. */
  | "gate-unreachable";

/**
 * The failure of a request that the bridge refuses to serve without the gate. Without the plugin the CLI can send
 * model requests that Flywheel did not admit, and managed settings can block a plugin or its hooks. A hook that
 * cannot reach its socket refuses every step, so no request of the query can succeed. A missing plugin and an unasked
 * step are permanent for the configuration, and an unreachable gate is permanent when a fresh engine meets it again
 * (bridge.ts), so the request fails as a validation error, which no retry or failover repeats.
 */
export function stepGateFailure(fault: StepGateFault, plugin: string = STEP_GATE_PLUGIN): ProviderRequestValidationError {
  const managed = "A managed setting such as allowManagedModsOnly, allowManagedHooksOnly, disableAllHooks, or disableSideloadFlags stops the plugin.";
  const reason = fault === "plugin-not-loaded"
    ? `the Claude CLI did not load Flywheel's ${plugin} plugin, so it could send model requests that Flywheel did not admit. ${managed}`
    : fault === "step-not-asked"
      ? `the Claude CLI sent a model request without asking Flywheel's ${plugin} plugin, so it could send model requests that Flywheel did not admit. ${managed}`
      : `the Claude CLI's ${plugin} plugin could not reach Flywheel's step gate, so it refused every model request. `
        + "A sandbox that blocks Unix domain sockets, or a temporary directory path that is too long for a socket, stops the plugin's hook.";
  return new ProviderRequestValidationError(CLAUDE_AGENT_SDK_LABEL, reason);
}
