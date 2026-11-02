/** `flywheel events search --reconstruct` through the real CLI entry, in a
 *  process that runs neither `tests/preload.ts` nor the source launcher. Both
 *  install the module catalog ahead of any command, so only a process like a
 *  release proves that the command loads the catalog it reads: the fold labels
 *  historical framing through the installed modules. */

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js";
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js";
import { buildSessionContext } from "../../../src/orchestration/session/conversation/conversation-tree-context.js";
import { createConversationTree } from "../../../src/orchestration/session/conversation/conversation-tree-handle.js";
import { appendProviderRequestFacts } from "../../unit/orchestration/session/_provider-request-audit-fixtures.js";

const ENTRY = join(import.meta.dir, "..", "..", "..", "src", "cli", "index.ts");
const SESSION_ID = "reconstruct-session";
const CONVERSATION_ID = "reconstruct-conversation";

let home = "";
let projectRoot = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flywheel-event-reconstruct-"));
  projectRoot = join(home, "project");
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A first-of-turn request whose history holds a system-origin message, the
 *  kind the fold asks the installed modules to label. */
async function seedRequest(): Promise<string> {
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot));
  const tree = await createConversationTree({ conversationId: CONVERSATION_ID, sessionId: SESSION_ID, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
  await tree.appendMessage({ kind: "user", content: "first question" });
  await tree.appendMessage({ kind: "user", origin: "system", content: "a runtime notice" });
  const treeLeafEntryId = await tree.getLeafId();
  const { messages } = buildSessionContext(await tree.getBranch());
  await tree.getStorage().dispose();
  const requestId = appendProviderRequestFacts(store, SESSION_ID, {
    identity: { providerSessionKey: CONVERSATION_ID, conversationId: CONVERSATION_ID }, turn: 1, promptKind: "chat",
    systemPrompt: "be helpful",
    messages,
    messageCount: messages.length,
    estimatedContextTokens: 10, contextWindow: 200_000,
    tools: [], omittedTools: [],
    attemptStaticTokens: 1, interactionProfileId: "default",
    model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
    treeLeafEntryId,
  });
  store.close();
  return requestId;
}

it("reconstructs a recorded request in a process whose entry installed no module catalog", async () => {
  const requestId = await seedRequest();

  // The installed launcher runs the entry with the browser condition.
  const proc = Bun.spawn(["bun", "--conditions=browser", ENTRY, "events", "search", "--session", SESSION_ID, "--reconstruct", requestId, "--json"], {
    cwd: projectRoot,
    env: { ...process.env, HOME: home, FLYWHEEL_PROJECT_ROOT: projectRoot },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ requestId, kind: "reconstructed", verified: true, systemPrompt: "be helpful" });
}, 30_000);
