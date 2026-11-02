import { randomUUID } from "node:crypto";
import { DebugLog } from "../../../../infra/debug-log.js";
import { asRecord } from "../../../../infra/record.js";
import { servePluginGate, type PluginGateServer } from "../step-gate.js";
import pluginManifest from "./host-plugin/plugin.json" with { type: "json" };
import pluginHooks from "./host-plugin/hooks/hooks.json" with { type: "json" };
import pluginHookModule from "./host-plugin/hooks/register.js.txt";

/** The plugin's manifest name. The CLI lists it in `system/init.plugins` when it loaded the plugin, and it names
 *  each agent definition that the plugin holds as `agent-host:<name>`. */
export const AGENT_HOST_PLUGIN = pluginManifest.name;
/** The plugin's own files by their path in each host's private copy (the step gate's plugin explains the form). */
const AGENT_HOST_PLUGIN_FILES = {
  ".claude-plugin/plugin.json": JSON.stringify(pluginManifest),
  "hooks/hooks.json": JSON.stringify(pluginHooks),
  "hooks/register.js": pluginHookModule,
};
/** The CLI variable through which the plugin's hook finds the socket of its host. */
export const AGENT_HOST_SOCKET_VARIABLE = "AGENT_HOST_SOCKET";

/** The token usage that a hosted agent's step states at its stop, as the service reported it. */
interface HostUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
}

/** One chunk of a hosted agent's model response, as the `turn.step` hook yields it (CLI 2.1.306). Text, thinking,
 *  and input chunks are deltas of the block at `index`; `tool` starts a tool use block. A redacted thinking block
 *  yields no chunk. */
export type HostStepItem =
  | { readonly kind: "text" | "thinking"; readonly index: number; readonly text: string }
  | { readonly kind: "input"; readonly index: number; readonly json: string }
  | { readonly kind: "tool"; readonly index: number; readonly id: string; readonly name: string }
  | { readonly kind: "stop"; readonly stopReason: string | null; readonly usage: HostUsage | null };

/** Where the chunks of one admitted step go. Each method returns at once. */
export interface AgentStepSink {
  item(item: HostStepItem): void;
  /** The step's response ended, with its stop chunk or without it. */
  done(): void;
}

/** What the gate states for an admitted step: its effort, or none for a model without efforts, and, for a coordinator
 *  step, a model that replaces the host's launch model. The engine's `turn.step` hook can change only these two values
 *  of a step (CLI 2.1.292 `Is` in module 568); every other request value is the host's own, and an agent's model is
 *  its definition's. */
export interface StepValues {
  readonly effort?: string;
  readonly model?: string;
}

/** One open admission of a hosted agent: it admits that agent's next step once. */
export interface AgentAdmission {
  /** Withdraws the admission: a later step of the agent is refused, and chunks of its step reach no sink. */
  close(): void;
}

/** A step that the gate refused, for the host's record. */
export interface RefusedHostStep {
  readonly turnId: string;
  readonly index: number;
  readonly agentId: string | undefined;
}

/**
 * The admission of one shared agent host (spike results, "Admission protocol"). The plugin drops every
 * task-notification prompt itself. A main-thread turn is a dispatch turn only when its start text holds a nonce
 * that the host pushed and has not seen yet; the gate admits that turn's step 0 and the step 1 that continues it
 * after the SendMessage results, both with the dispatcher's values, and the step 2 that answers a call of step 1 that
 * the host denied (`denied`), and refuses every other main-thread step.
 * A hosted agent's step is admitted only while the agent holds an unused admission, and that step's chunks go to the
 * admission's sink. Every refused step answers as the empty refusal: no text, no tool use, no stop reason.
 */
export interface HostGate {
  /** A fresh nonce for the next dispatch frame, which the frame's text carries. The gate keeps the frame's record
   *  until `retire` or `close`. */
  nonce(): string;
  /** How many steps of the dispatch turn that `nonce` started the gate admitted. */
  dispatcherSteps(nonce: string): number;
  /** The host denied a call of the step that the dispatch turn of `nonce` runs now. A denial in step 1 makes the gate
   *  also admit step 2, which answers it; a later denial admits nothing more. */
  denied(nonce: string): void;
  /** The frame of `nonce` ended: the gate forgets its turn and steps, and refuses every later step of that turn. */
  retire(nonce: string): void;
  /** Admits the next step of `agentId` once with `values`. A newer admission of the agent replaces this one. */
  admit(agentId: string, values: StepValues, sink: AgentStepSink): AgentAdmission;
  /** Refuses every later step and drops every admission. */
  close(): void;
  /** Answers one plugin request: `path` names the hook's call, `body` is its parsed JSON. A step that the gate can
   *  admit answers once the host settled what its engine owes before a step sends (`HostGateHooks.settled`). */
  serve(path: string, body: unknown): GateAnswer | Promise<GateAnswer> | undefined;
}

type GateAnswer = { readonly admit?: boolean } & StepValues;

/** What the gate asks of its host. Each callback returns at once, except `settled`. */
export interface HostGateHooks {
  /** The values with which each admitted dispatcher step sends, read when the step asks. */
  dispatcherValues(): StepValues;
  /** The dispatch turn of `nonce` opened, or the gate admitted one of its steps. */
  dispatcherAdvanced(nonce: string): void;
  /** The dispatch turn of `nonce` asks for a step that the gate can admit. The engine asks only after the turn's last
   *  response ended. */
  dispatcherAsked(nonce: string): void;
  /** The gate admitted a step of the agent, which now sends its one request. */
  agentAdmitted(agentId: string): void;
  refused(step: RefusedHostStep): void;
  /** Settles the usage report that a complete response of the engine owes before a step sends. Resolves false when the
   *  host's usage guard stopped the account, so the step is refused. */
  settled(): Promise<boolean>;
}

/** The record of one dispatch frame, by its nonce. */
interface DispatchTurn {
  /** The engine's id of the turn that the frame's text opened; undefined until `/turn` names it. */
  turnId: string | undefined;
  /** The steps of the turn that the gate admitted. */
  admitted: number;
  /** The last step index that the turn may send: 1, or more after a denial, never past `LAST_DISPATCHER_STEP`. */
  last: number;
}

interface OpenAdmission {
  readonly values: StepValues;
  readonly sink: AgentStepSink;
  used: boolean;
  closed: boolean;
}

/** The last step that a dispatch turn may send: step 0 sends, step 1 reads the results, and step 2 answers a denial in
 *  step 1. A dispatcher that repeats a denied call past it is refused, which ends the frame. */
const LAST_DISPATCHER_STEP = 2;

/** Builds the gate of one host. */
export function createHostGate(hooks: HostGateHooks): HostGate {
  /** The record of each frame that the host has not retired, by nonce. The host sends one frame at a time, so this
   *  holds at most one record. */
  const turns = new Map<string, DispatchTurn>();
  const admissions = new Map<string, OpenAdmission>();
  /** The admission whose step streams now, by agent. */
  const streaming = new Map<string, OpenAdmission>();
  let closed = false;
  const refuse = (step: RefusedHostStep) => {
    hooks.refused(step);
    return { admit: false };
  };
  const turnOf = (turnId: string) => {
    for (const [nonce, turn] of turns) if (turn.turnId === turnId) return { nonce, turn };
    return undefined;
  };
  const streamingSink = (body: { readonly [field: string]: unknown } | undefined): AgentStepSink | undefined => {
    const agentId = body?.["agentId"];
    if (typeof agentId !== "string") return undefined;
    const open = streaming.get(agentId);
    return open === undefined || open.closed ? undefined : open.sink;
  };
  return {
    nonce() {
      const nonce = `fw-dispatch-${randomUUID()}`;
      turns.set(nonce, { turnId: undefined, admitted: 0, last: 1 });
      return nonce;
    },
    dispatcherSteps: (nonce) => turns.get(nonce)?.admitted ?? 0,
    denied(nonce) {
      const turn = turns.get(nonce);
      // Steps are admitted in order, so the count of admitted steps is the index of the step that answers the denial.
      if (turn !== undefined) turn.last = Math.min(LAST_DISPATCHER_STEP, Math.max(turn.last, turn.admitted));
    },
    retire(nonce) {
      turns.delete(nonce);
    },
    admit(agentId, values, sink) {
      const previous = admissions.get(agentId);
      if (previous !== undefined) previous.closed = true;
      const open: OpenAdmission = { values, sink, used: false, closed };
      if (!closed) admissions.set(agentId, open);
      return {
        close: () => {
          open.closed = true;
          if (admissions.get(agentId) === open) admissions.delete(agentId);
          if (streaming.get(agentId) === open) streaming.delete(agentId);
        },
      };
    },
    close() {
      closed = true;
      turns.clear();
      for (const open of admissions.values()) open.closed = true;
      admissions.clear();
      streaming.clear();
    },
    serve(path, parsed) {
      const body = asRecord(parsed);
      switch (path) {
        case "/turn": {
          const turnId = body?.["turnId"];
          const text = body?.["text"];
          if (closed || typeof turnId !== "string" || typeof text !== "string") return {};
          // A nonce opens one turn only.
          for (const [nonce, turn] of turns) {
            if (turn.turnId !== undefined || !text.includes(nonce)) continue;
            turn.turnId = turnId;
            hooks.dispatcherAdvanced(nonce);
          }
          return {};
        }
        case "/step": {
          const turnId = body?.["turnId"];
          const index = body?.["index"];
          const agentId = body?.["agentId"];
          if (typeof turnId !== "string" || typeof index !== "number" || (agentId !== null && typeof agentId !== "string")) return undefined;
          const step = { turnId, index, agentId: agentId ?? undefined };
          if (closed) return refuse(step);
          if (agentId === null) {
            const dispatch = turnOf(turnId);
            if (dispatch === undefined || index > dispatch.turn.last) return refuse(step);
            hooks.dispatcherAsked(dispatch.nonce);
            return hooks.settled().then((go) => {
              if (!go || turns.get(dispatch.nonce) !== dispatch.turn) return refuse(step);
              dispatch.turn.admitted += 1;
              hooks.dispatcherAdvanced(dispatch.nonce);
              return { admit: true, ...hooks.dispatcherValues() };
            });
          }
          const open = admissions.get(agentId);
          if (open === undefined || open.used || open.closed) return refuse(step);
          // The step uses the admission up now, so a second ask of the agent while the host settles is refused.
          open.used = true;
          return hooks.settled().then((go) => {
            if (!go || open.closed) return refuse(step);
            streaming.set(agentId, open);
            hooks.agentAdmitted(agentId);
            return { admit: true, ...open.values };
          });
        }
        case "/item": {
          const item = hostStepItem(body?.["item"]);
          const sink = streamingSink(body);
          if (item !== undefined) sink?.item(item);
          return {};
        }
        case "/done": {
          streamingSink(body)?.done();
          return {};
        }
        default:
          return undefined;
      }
    },
  };
}

/** One hook chunk read at the socket boundary; undefined for a chunk that Flywheel does not read. */
function hostStepItem(value: unknown): HostStepItem | undefined {
  const item = asRecord(value);
  const kind = item?.["kind"];
  const index = item?.["index"];
  if (kind === "stop") {
    const stopReason = item?.["stopReason"];
    return { kind, stopReason: typeof stopReason === "string" ? stopReason : null, usage: hostUsage(item?.["usage"]) };
  }
  if (typeof index !== "number") return undefined;
  if ((kind === "text" || kind === "thinking") && typeof item?.["text"] === "string") return { kind, index, text: item["text"] };
  if (kind === "input" && typeof item?.["json"] === "string") return { kind, index, json: item["json"] };
  if (kind === "tool" && typeof item?.["id"] === "string" && typeof item["name"] === "string") return { kind, index, id: item["id"], name: item["name"] };
  return undefined;
}

function hostUsage(value: unknown): HostUsage | null {
  const usage = asRecord(value);
  if (usage === undefined) return null;
  const count = (field: string) => {
    const counted = usage[field];
    return typeof counted === "number" ? counted : 0;
  };
  return { input_tokens: count("input_tokens"), output_tokens: count("output_tokens"), cache_read_input_tokens: count("cache_read_input_tokens"), cache_creation_input_tokens: count("cache_creation_input_tokens") };
}

/** Serves `gate` (`servePluginGate`) and copies the agent host's plugin beside it, whose `agents` folder holds the
 *  host's agent definitions. */
export function serveHostGate(gate: Pick<HostGate, "serve">): PluginGateServer {
  return servePluginGate({
    prefix: "agent-host-", files: AGENT_HOST_PLUGIN_FILES, answer: (path, body) => gate.serve(path, body),
    onRejected: (bytes) => { DebugLog.record({ type: "provider.claude_sdk.host_gate.rejected", payload: { bytes } }); },
  });
}
