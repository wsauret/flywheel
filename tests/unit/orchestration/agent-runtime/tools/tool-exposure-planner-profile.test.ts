import { describe, expect, it } from "bun:test";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { testSkill } from "../../../../helpers/skill-fixtures.js";
import { unusedSessionMessaging } from "../../../../helpers/child-session-control.js";
import { ALL_CAPABILITIES, askUserController, plan, skillRevision, subagentsRuntime, workflowsRuntime } from "./_planner-fixtures.js";

/** A messaging authority the planner only has to see. */
const sessionMessaging = unusedSessionMessaging();

describe("planToolExposure with a chat profile", () => {
  it("plans exactly the tools of an only profile and the tools of every session, ambient registrations included", async () => {
    const profiled = (only: readonly string[]) => plan({
      capabilities: ALL_CAPABILITIES,
      backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
      askUser: askUserController(),
      handoff: {},
      sessions: sessionMessaging,
      skills: skillRevision([testSkill("fixture")]),
    }, [["workflows", workflowsRuntime("on")], ["subagents", subagentsRuntime()]], { profile: { only: new Set(only) } });
    const identities = (planned: Awaited<ReturnType<typeof profiled>>) => new Set(planned.registrationIdentities.values());

    const planned = await profiled(["read", "ask_user"]);
    expect(identities(planned)).toEqual(new Set(["read", "ask_user", "message_session", "list_sessions"]));
    for (const name of ["process", "handoff", "workflow", "skill"]) {
      expect(planned.omitted).toContainEqual({ name, reason: "not in the chat profile" });
    }

    const withShell = await profiled(["read", "ask_user", "bash"]);
    expect(identities(withShell)).toEqual(new Set([...identities(planned), "bash"]));
  });
});
