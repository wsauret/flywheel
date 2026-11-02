import { mock } from "bun:test";
import type { BuiltInCommandContext } from "../../src/tui/commands/command-definitions.js";
import { refusingLauncher } from "./launcher-fake.js";
import { runtimeDispatch } from "./runtime-dispatch.js";

/** A complete shell context for built-in command tests. Every action is a
 *  recording mock, the foreground is chat "chat-1" at catalog revision 4, and
 *  the runtime rejects every mutation. A test overrides the members its
 *  command reads, scripts the runtime answers its command needs, and keeps
 *  its own reference to each mock it asserts on. */
export function testCommandContext(overrides: Partial<BuiltInCommandContext> = {}): BuiltInCommandContext {
  return {
    directories: { accountHome: "/account", userDataRoot: "/account/.flywheel" },
    launcher: refusingLauncher,
    appService: { dispatch: runtimeDispatch({}) },
    runtimeConfig: { view: () => undefined, settlePublication: async () => false },
    showToast: mock(() => {}),
    signals: { sessionInputMode: () => ({ kind: "chat" }), foregroundId: () => "chat-1", commandCatalogRevision: () => 4 },
    startClearedChat: mock(async () => {}),
    exit: mock(() => {}),
    restart: mock(async (): Promise<never> => { throw new Error("restart is not exercised") }),
    openThemeModal: mock(() => {}),
    openSurface: mock(() => true),
    captureSurfaceOpener: () => () => {},
    focusSession: mock(() => {}),
    refreshCommandCatalog: mock(async () => {}),
    agentInView: () => undefined,
    ...overrides,
  };
}
