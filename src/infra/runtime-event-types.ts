import type { Schema } from "effect";
import { RUNTIME_EVENT_DEFINITIONS as runtimeEventDefinitions } from "./runtime-fact-mapper.js";

export type { AssistantEventData, RateLimitEventData, UsageData } from "./runtime-event-payload-types.js";
type RuntimeEventActor = "agent" | "flywheel" | "provider" | "workflow";
export const RUNTIME_EVENT_DEFINITIONS = runtimeEventDefinitions;

interface RuntimeEventDefinition<T extends string, A extends RuntimeEventActor, S extends Schema.Decoder<unknown, never>> {
  readonly type: T;
  readonly actor: A;
  readonly data: S;
}

type RuntimeEventFor<D extends typeof RUNTIME_EVENT_DEFINITIONS[number]> = D extends RuntimeEventDefinition<infer T, RuntimeEventActor, infer S>
  ? { type: T; data: S["Type"] }
  : never;

export type RuntimeEvent = RuntimeEventFor<typeof RUNTIME_EVENT_DEFINITIONS[number]>;
export const RUNTIME_EVENT_TYPES: readonly RuntimeEvent["type"][] = RUNTIME_EVENT_DEFINITIONS.map(({ type }) => type);
export const DURABLE_RUNTIME_EVENT_TYPES: readonly RuntimeEvent["type"][] = RUNTIME_EVENT_DEFINITIONS.filter((definition) => definition.durable).map(({ type }) => type);
export const DEBUG_RUNTIME_EVENT_TYPES: readonly RuntimeEvent["type"][] = RUNTIME_EVENT_DEFINITIONS.filter((definition) => definition.debug).map(({ type }) => type);
