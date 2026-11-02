import { describe, expect, it } from "bun:test";
import { createJudge } from "../../../bench/shared/runtime.js";
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory.js";
import type { AgentOptions } from "../../../src/orchestration/agent-runtime/types.js";
import { roleCapture } from "../../helpers/role-capture.js";

describe("shared benchmark judge factory", () => {
  it("builds a tool-free Agent judge with the rubric as its literal system prompt", async () => {
    let received: AgentOptions | undefined;
    const deps = {
      userDataRoot: "/user-data",
      accountHome: "/home",
      captureProviderConnection: async () => roleCapture(["gpt-6.1-sol"]),
      createAgent: (options: AgentOptions) => {
        received = options;
        return {
          send: () => options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
            type: "model.assistant_message.recorded",
            message: { content: [{ type: "text", text: "graded" }] },
          })),
          end: () => undefined,
          abort: () => undefined,
          done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" as const } }),
        };
      },
    };

    const judge = await createJudge(deps, "judge-model", "grading rubric");
    const completion = await judge.complete("score this run", new AbortController().signal);

    expect(received?.model).toBe("judge-model");
    expect(received?.purpose).toEqual({ kind: "headless-task", prompt: { kind: "literal", systemPrompt: "grading rubric" } });
    expect(received?.toolProfile).toBe("none");
    expect(received?.conversation).toEqual({ kind: "stateless" });
    expect(received?.lifecycle).toEqual({ kind: "one-shot" });
    const roles = await received?.resolveRoles?.();
    expect(roles && await received?.requestSelection?.(roles)).toMatchObject({ roleId: "benchmark-judge", model: "gpt-6.1-sol", effort: "high" });
    expect(completion.text).toBe("graded");
    expect(completion.accounting.estimatedUsd.kind).toBe("unavailable");
  });
});
