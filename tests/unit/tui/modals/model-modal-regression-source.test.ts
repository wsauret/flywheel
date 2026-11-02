import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("model modal regressions", () => {
  test("modal assignments do not derive the footer model", async () => {
    const hookSource = await Bun.file(
      fileURLToPath(new URL("../../../../src/tui/hooks/use-model-modal.ts", import.meta.url)),
    ).text();
    const controllerSource = await Bun.file(
      fileURLToPath(new URL("../../../../src/orchestration/config/model-assignment-controller.ts", import.meta.url)),
    ).text();

    expect(hookSource).not.toContain("globalDefaultChat");
    expect(hookSource).not.toContain("globalDefaultRoles");
    expect(hookSource).not.toContain("chatLabel");
    expect(hookSource).not.toContain('r.slot.roleId === "chat"');
    expect(controllerSource).toContain("loadGlobalDefaultRoles");
    expect(controllerSource).toContain("return loadAssignments(slots)");
  });
});
