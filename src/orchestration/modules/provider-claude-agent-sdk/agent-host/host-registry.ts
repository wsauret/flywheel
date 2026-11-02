import { createHash } from "node:crypto";
import { DebugLog } from "../../../../infra/debug-log.js";
import type { AccessProviderCandidateAttribution } from "../../../../infra/llm/access-provider.js";
import type { ModelInfo } from "../../../../infra/llm/models.js";
import { mapAnthropicAdaptiveEffort } from "../../../agent-runtime/llm/anthropic-options.js";
import { supportsAdaptiveThinking } from "../../../agent-runtime/llm/model-compat.js";
import { anthropicOutputLimit } from "../../../agent-runtime/llm/provider-description.js";
import { orderedJson } from "../cli-view.js";
import { registerHostDrain } from "../live-bridges.js";
import type { ExtraUsage } from "../extra-usage-guard.js";
import type { EngineValues } from "../query-engine.js";
import type { AgentHost } from "./host.js";

/** The values that a host's engine fixes for its coordinator and all its agents: the request values that the engine
 *  sends in every request, and whether the requests state an effort. No model is among them: each agent's definition
 *  states its own model (`AgentHost.definition`), and the host picks its coordinator's model when it opens
 *  (`coordinatorCandidates`). The host's gate states each agent's effort for each step that it admits
 *  (`HostGate.admit`). Each agent's values were prepared for its own model, so agents of different models share a
 *  host whenever their values are equal. */
export type HostValues = Omit<EngineValues, "effort" | "wireModelId" | "contextLimit"> & { readonly statesEffort: boolean };

/** What decides which host serves an agent: the login, the spend mode, the chat tree, the git status of the agent's
 *  directory, and every value that the host's engine fixes. The agent's directory is no part of it: a resumed agent
 *  runs in the directory that its meta file states (`AgentFileInput.cwd`). */
export interface HostPlace {
  readonly configDir: string;
  /** The usage reports of a host carry no agent id, so one host reads them for one spend mode. */
  readonly extraUsage: ExtraUsage;
  readonly treeRootSessionId: string;
  /** Whether the agent's directory is in a git repository. The engine states this fact for the directory of its
   *  process, not for the directory of each agent. */
  readonly gitRepository: boolean;
  readonly values: HostValues;
}

/** The effort of every coordinator step of a host whose requests state an effort, which keeps its calls short. */
export const COORDINATOR_EFFORT = "low";

/** The place of each Claude model family from the cheapest to the most expensive, which a host's coordinator tries in
 *  this order, whatever the version of each model. */
const COORDINATOR_FAMILIES = ["haiku", "sonnet", "opus", "fable"];
const FAMILY = new RegExp(`^claude-(${COORDINATOR_FAMILIES.join("|")})-`, "u");

/** The values of the host that serves an agent whose requests send `values`. */
export function hostValues({ effort, wireModelId, contextLimit, ...sent }: EngineValues): HostValues {
  return { ...sent, statesEffort: effort !== undefined };
}

/** One model on which a host's coordinator can run: its wire id, and its launch model in the engine's spelling
 *  (`engineModelId`). */
export interface Coordinator {
  readonly wireModelId: string;
  readonly model: string;
}

/**
 * The models on which a host with `values` can run its coordinator, in the order in which it tries them: every model
 * of the login's `lineup` that accepts `values`, by family from Haiku to Fable and within a family from the newest
 * release to the oldest, a model with no known release last. `own`, the model of the agent that opens the host, in
 * its engine spelling, keeps its place in that order when the lineup lists it, and else comes last, as the one model
 * that is known to accept the values. The list does not end at `own`: a later agent of the host can run on a model
 * that costs more, and its requests need a coordinator after every cheaper one failed. A model accepts the values when
 * it takes their thinking shape, their `max_tokens`, and, when the requests state an effort, `COORDINATOR_EFFORT`. A
 * model whose facts Flywheel does not know is left out.
 */
export function coordinatorCandidates(lineup: readonly Pick<AccessProviderCandidateAttribution, "wireModelId" | "resolvedModelMetadata">[], values: HostValues, own: Coordinator): readonly [Coordinator, ...Coordinator[]] {
  // An account can offer one wire model under several data uses.
  const models = new Map(lineup.map(({ wireModelId, resolvedModelMetadata }) => [wireModelId, resolvedModelMetadata]));
  const ranked = [...models].flatMap(([wireModelId, info]) => {
    const family = FAMILY.exec(wireModelId)?.[1];
    if (family === undefined || info === undefined || !acceptsValues(wireModelId, info, values)) return [];
    return [{ coordinator: wireModelId === own.wireModelId ? own : { wireModelId, model: wireModelId }, rank: COORDINATOR_FAMILIES.indexOf(family), releaseDate: info.releaseDate }];
  });
  const ordered = ranked.toSorted((left, right) => left.rank - right.rank || newestFirst(left.releaseDate, right.releaseDate)).map(({ coordinator }) => coordinator);
  // The list always holds `own`, so the default never applies.
  const [launch = own, ...after] = ordered.includes(own) ? ordered : [...ordered, own];
  return [launch, ...after];
}

function acceptsValues(wireModelId: string, info: ModelInfo, values: HostValues): boolean {
  if (values.thinking?.type === "adaptive" && !supportsAdaptiveThinking(wireModelId, info)) return false;
  const { max_tokens: maxTokens } = values.extraBody;
  if (maxTokens !== undefined && maxTokens > anthropicOutputLimit(info)) return false;
  return !values.statesEffort || mapAnthropicAdaptiveEffort(info, COORDINATOR_EFFORT) === COORDINATOR_EFFORT;
}

/** Orders ISO release dates from the newest, with an unknown date after every known one. */
function newestFirst(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left < right ? 1 : -1;
}

/*
 * One chat tree runs at most two engine processes: the chat's own engine, and one shared host for every other
 * Claude call of the tree. Every agent of the tree must send the same host place. When one value of the place is
 * different for an agent, that agent starts another engine process. Do not make a value different for one kind of
 * agent. If a difference is absolutely necessary, add its field to `HOST_SPLIT_EXCEPTIONS` with its reason, and know
 * that each difference duplicates a binary process. A tree that opens a second host records one
 * `provider.claude_sdk.host.split` record, which names the fields that differ.
 */

/** Each field of a host place that can differ inside one chat tree, by its path in `hostPlaceDifference`, with the
 *  reason that the split is accepted. A difference in any other field is a defect. */
export const HOST_SPLIT_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ["configDir", "A different login runs its own engine."],
  ["extraUsage", "A change of spend mode: the usage reports of a host carry no agent id."],
  ["gitRepository", "The engine states the git status of its process directory, which must agree with the agent's directory."],
  ["values.thinking.display", "A role that sets thinking_display. The user accepts a split for it."],
  ["values.extraBody", "A role that sets extra_body. The user accepts a split for it."],
  ["values.thinking.type", "A model chosen deliberately that has no adaptive thinking."],
  ["values.thinking.budget_tokens", "A model chosen deliberately that has no adaptive thinking."],
  ["values.statesEffort", "A model chosen deliberately that has no adaptive thinking: its requests state no effort."],
]);

/** The body fields that the engine values state themselves (`engineValues`). Every other field of `extraBody` comes
 *  from a role's extra_body. */
const ENGINE_BODY_FIELDS = new Set(["max_tokens", "tool_choice"]);

/** The key of the host for `place`. Two agents share a host exactly when their keys are equal. */
export function hostKey(place: HostPlace): string {
  return createHash("sha256").update(orderedJson(place)).digest("hex");
}

/** The paths of the fields in which `a` and `b` differ, each once: a dotted path to each differing value, where an
 *  array is one value, and `values.extraBody` for every field of a role's extra_body. Empty when the places give one
 *  key. */
export function hostPlaceDifference(a: HostPlace, b: HostPlace): readonly string[] {
  const left = leaves(a);
  const right = leaves(b);
  const paths = new Set([...left.keys(), ...right.keys()].filter((path) => orderedJson(left.get(path)) !== orderedJson(right.get(path))));
  return [...new Set([...paths].map((path) => {
    const [, field] = /^values\.extraBody\.([^.]+)/u.exec(path) ?? [];
    return field === undefined || ENGINE_BODY_FIELDS.has(field) ? path : "values.extraBody";
  }))];
}

/** Each value of `value` that is not a plain object with fields, by its dotted path below `path`. An empty object is a
 *  value: the key hashes it, so the difference must name it. */
function leaves(value: unknown, path = "", into = new Map<string, unknown>()): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) into.set(path, value);
  else for (const [field, inner] of Object.entries(value)) leaves(inner, path === "" ? field : `${path}.${field}`, into);
  return into;
}

/** One use of a host: a hosted agent that runs or waits for its results, or a session that a client shows, which
 *  holds the host that its roles run on. */
export interface HostLease {
  readonly host: AgentHost;
  /** The lease opened the host; else the host ran already for another use. */
  readonly opened: boolean;
  /** Ends the use. The host closes when its last use ends, so a host of sessions that no client shows closes when
   *  their work ends. Resolves once the use ended: at once while other uses remain, else when the host's close settled. */
  release(): Promise<void>;
}

/** The hosts of one process, by key. Flywheel caps neither the hosts nor their agents. */
export interface HostRegistry {
  /** The host of `place` (`hostKey`), which `open` opens when no open host has that key. An open while the place's
   *  tree has an open host records the split (`provider.claude_sdk.host.split`). */
  lease(place: HostPlace, open: () => AgentHost): HostLease;
  /** Closes every host at once, at the process's shutdown, and waits for the closes, also those of hosts that their
   *  last use or their own end closed. No selection change closes a host that a use holds: a module turned off lets
   *  each use go once its request settled (`releaseLiveBridges`). */
  drain(): Promise<void>;
}

interface Entry {
  readonly host: AgentHost;
  readonly place: HostPlace;
  leases: number;
  /** The host's close, once the registry asked for it. */
  closed: Promise<void> | undefined;
}

export function createHostRegistry(): HostRegistry {
  const entries = new Map<string, Entry>();
  /** The closes that run now. A closing host serves no new lease, so it leaves `entries` at once, and `drain` waits for
   *  its close here. */
  const closing = new Set<Promise<void>>();
  const close = (key: string, entry: Entry, reason: string): Promise<void> => {
    if (entries.get(key) === entry) entries.delete(key);
    if (entry.closed !== undefined) return entry.closed;
    const closed = entry.host.close(reason);
    entry.closed = closed;
    closing.add(closed);
    void closed.finally(() => { closing.delete(closed); });
    return closed;
  };
  return {
    lease(place, open) {
      const key = hostKey(place);
      let entry = entries.get(key);
      const opens = entry === undefined;
      if (entry === undefined) {
        // Opens are rare, so the tree's open host is found by a scan of the open hosts.
        const tree = [...entries.values()].find((other) => other.place.treeRootSessionId === place.treeRootSessionId);
        const host = open();
        const opened: Entry = { host, place, leases: 0, closed: undefined };
        entries.set(key, opened);
        void host.ended.then(() => close(key, opened, "ended"));
        entry = opened;
        if (tree !== undefined) {
          const fields = hostPlaceDifference(tree.place, place);
          DebugLog.record({ type: "provider.claude_sdk.host.split", payload: {
            treeRootSessionId: place.treeRootSessionId, sessionId: host.sessionId, openHostSessionId: tree.host.sessionId,
            fields, exception: fields.every((field) => HOST_SPLIT_EXCEPTIONS.has(field)),
          } });
        }
      }
      const leased = entry;
      leased.leases += 1;
      let released = false;
      return {
        host: leased.host,
        opened: opens,
        release: async () => {
          if (released) return;
          released = true;
          leased.leases -= 1;
          if (leased.leases > 0) return;
          await close(key, leased, "released");
        },
      };
    },
    async drain() {
      for (const [key, entry] of entries) void close(key, entry, "shutdown");
      await Promise.all(closing);
    },
  };
}

/** The hosts of this process, which the module's service drains (`drainAgentHosts`). */
export const processAgentHosts: HostRegistry = createHostRegistry();
registerHostDrain(() => processAgentHosts.drain());
