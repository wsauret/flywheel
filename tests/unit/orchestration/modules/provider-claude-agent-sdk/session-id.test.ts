import { expect, test } from "bun:test";
import { bridgeSessionId, isBridgeSessionId } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/session-id.js";

test("session ids are new for each call, tagged, and never a CLI version-4 id", () => {
  const pattern = /^9d3b72e1-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const [first, second] = [bridgeSessionId(), bridgeSessionId()];

  expect(first).not.toBe(second);
  expect([first, second].every((id) => pattern.test(id))).toBe(true);
  expect([isBridgeSessionId(first), isBridgeSessionId("6f1d4f7c-2b1a-4c8e-9f3a-1b2c3d4e5f60")]).toEqual([true, false]);
});
