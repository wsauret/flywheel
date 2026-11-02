import { describe, expect, test } from "bun:test";
import { normalizeAuthProfile } from "../../../../src/infra/auth/auth-profile-normalization.js";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import type { AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

/** A provider that declares one conversion in each phase and records when each runs. */
function converting(id: string, order: string[]): AccessProviderDefinition {
  return {
    id, displayName: id, shortName: id, billing: "subscription", rank: 1, supportedFamilies: ["anthropic"], configHints: [], catalogId: undefined, cli: { name: id },
    auth: { kind: "api_key", statusRank: 1 },
    profileConversions: [
      { phase: "after-decode", convert: async () => { order.push(`${id} after`); } },
      { phase: "before-decode", convert: async () => { order.push(`${id} before`); } },
    ],
  };
}

describe("auth profile normalization", () => {
  test("runs each installed provider's profile conversions, every pre-decode conversion before the store is decoded and the rest after, by provider id", async () => {
    const access = await new AuthProfileStore(temporaryDirectory("auth-normalization-")).create("work");
    const directory = access.authDirectory;
    access.close();
    const order: string[] = [];

    await normalizeAuthProfile(directory, () => "metered", [], [converting("b_provider", order), converting("a_provider", order)]);

    expect(order).toEqual(["a_provider before", "b_provider before", "a_provider after", "b_provider after"]);
  });
});
