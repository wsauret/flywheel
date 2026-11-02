import { expect, test } from "bun:test";
import { extraUsageNotice } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/extra-usage-guard.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const account = { providerId: "claude_agent_sdk", instanceId: "account-uuid", configDir: `/scratch/.flywheel/auth/profiles/default/${LOGIN_ACCOUNTS_DIRECTORY}/a`, name: "person@example.com" };

test("the notice of a stop names the account, says that the account used extra usage and that Flywheel stopped it, and points to Provider Settings", () => {
  const notice = extraUsageNotice({ evidence: "extra-usage", heldUntilMs: 1_791_540_527_000 }, account);

  expect(notice).toMatchObject({ title: "Claude extra usage stopped", severity: "alert", action: { kind: "open-auth-provider", providerId: "claude_agent_sdk" } });
  expect(notice.message).toBe("person@example.com served a Claude request from extra usage. Paid use is off for this account, so Flywheel stopped using it until its included usage resets. "
    + "To allow extra usage, turn on paid use for this account in Provider Settings.");
  // The notice names the account only in its text: its source id holds no account data.
  expect(notice.sourceId).not.toContain("person@example.com");
  expect(notice.sourceId).not.toContain("account-uuid");
});

test("one login's stops share one notice, whatever the evidence, and another account, or the same account's login in another profile, gets its own", () => {
  const unreported = extraUsageNotice({ evidence: "unreported", heldUntilMs: 300_000 }, account);

  expect(unreported.sourceId).toBe(extraUsageNotice({ evidence: "extra-usage", heldUntilMs: undefined }, account).sourceId);
  expect(unreported.sourceId).not.toBe(extraUsageNotice({ evidence: "unreported", heldUntilMs: 300_000 }, { ...account, instanceId: "other" }).sourceId);
  expect(unreported.sourceId).not.toBe(extraUsageNotice({ evidence: "unreported", heldUntilMs: 300_000 }, { ...account, configDir: `/scratch/.flywheel/auth/profiles/work/${LOGIN_ACCOUNTS_DIRECTORY}/b` }).sourceId);
  expect(unreported.message).toBe("The Claude engine did not show that person@example.com served a request from included usage, so the request can have used extra usage. "
    + "Paid use is off for this account, so Flywheel stopped using it for a few minutes. To allow extra usage, turn on paid use for this account in Provider Settings.");
});
