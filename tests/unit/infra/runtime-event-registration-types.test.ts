import { expect, test } from "bun:test";
import type { RuntimeEventProjectorDecisions } from "../../../src/infra/output/runtime-event-projector.js";
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../src/infra/runtime-fact-mapper.js";

type SyntheticRuntimeEventType = "model.assistant_message.recorded" | "tool.result.recorded";

type Accepts<Target, Value> = Value extends Target ? true : false;

// The annotation fails to compile if the decision map ever accepts a missing key.
const incompleteMapAccepted: Accepts<
  RuntimeEventProjectorDecisions<SyntheticRuntimeEventType>,
  { "model.assistant_message.recorded": null }
> = false;

test("runtime event decision maps require every registered key", () => {
  expect(incompleteMapAccepted).toBe(false);
});

test("tool result availability has no durable fact mapping", () => {
  expect(mapRuntimeEventToSessionRuntimeFacts({
    type: "tool.result.available",
    data: {
      tool_use_id: "tool_1",
      content: [{ type: "text", text: "final" }],
      outcome: "ok",
    },
  })).toEqual([]);
});
