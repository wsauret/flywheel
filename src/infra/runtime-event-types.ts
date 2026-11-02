import { Result, Schema } from "effect";
import type {
  AssistantEventData,
  GenericEventData,
  RateLimitEventData,
  UsageData,
} from "./runtime-event-payload-types.js";
import { RUNTIME_EVENT_DEFINITIONS as runtimeEventDefinitions } from "./runtime-fact-mapper.js";

export type { AssistantEventData, RateLimitEventData, UsageData };
export type RuntimeEventActor = "agent" | "flywheel" | "provider" | "workflow";
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

const runtimeEventDefinitionsByType = new Map(
  RUNTIME_EVENT_DEFINITIONS.map((definition) => [definition.type, definition]),
);

export function runtimeEventActor(type: RuntimeEvent["type"]): RuntimeEventActor {
  const definition = runtimeEventDefinitionsByType.get(type);
  if (!definition) throw new Error(`No runtime event definition registered for ${type}`);
  return definition.actor;
}

export type RuntimeEventDurableMapper = NonNullable<typeof RUNTIME_EVENT_DEFINITIONS[number]["durable"]>;

export function runtimeEventDurableMapper(type: RuntimeEvent["type"]): RuntimeEventDurableMapper | undefined {
  return runtimeEventDefinitionsByType.get(type)?.durable;
}

type PayloadParser = (data: GenericEventData) => RuntimeEvent;
const payloadParsers = new Map<RuntimeEvent["type"], PayloadParser>(
  RUNTIME_EVENT_DEFINITIONS.map((definition) => [definition.type, parserFor(definition)]),
);

export function parseRuntimeEventPayload<T extends RuntimeEvent["type"]>(
  requestedType: T,
  data: GenericEventData,
): Extract<RuntimeEvent, { type: T }> {
  const parser = payloadParsers.get(requestedType);
  if (!parser) throw new Error(`No runtime event payload parser registered for ${requestedType}`);
  // SAFETY: The indexed parser was created from the definition with the requested discriminant.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: schema registry erases the discriminant and decoded payload correlation
  return parser(data) as Extract<RuntimeEvent, { type: T }>;
}

function parserFor(definition: typeof RUNTIME_EVENT_DEFINITIONS[number]): PayloadParser {
  return (data) => {
    const parsed = Schema.decodeUnknownResult(definition.data)(data);
    if (Result.isFailure(parsed)) {
      throw new Error(`Invalid ${definition.type} event payload`, { cause: parsed.failure });
    }
    // SAFETY: Every runtime data schema decodes an object, and this parser preserves its definition's type.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: heterogeneous schema decoding erases the registered payload correlation
    return { type: definition.type, data: parsed.success } as RuntimeEvent;
  };
}
