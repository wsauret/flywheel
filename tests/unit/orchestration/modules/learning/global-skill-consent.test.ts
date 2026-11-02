import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";
import { Schema } from "effect";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore } from "../../../../../src/infra/event-store-types.js";
import { readMutationEvidenceFiles } from "../../../../../src/infra/mutation-evidence.js";
import { MutationEvidenceSchema } from "../../../../../src/infra/mutation-evidence-schema.js";
import { readSessionContentRange } from "../../../../../src/infra/session-content.js";
import { createSkillManageTool } from "../../../../../src/orchestration/modules/learning/tools/skill-manage.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createSessionFactWriter, type SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { loadAgentInputProjection } from "../../../../../src/orchestration/session/agent-input-projection.js";
import type { SkillWriteOrigin } from "../../../../../src/orchestration/modules/learning/skill-store-types.js";
import { publishSkillRevision, SKILL_FILE } from "../../../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../../../src/workflows/skills.js";

const TMP = fileTemporaryDirectory("flywheel-global-consent-test-");
const CWD = join(TMP, "project");
const DIRS = { projectRoot: CWD, accountHome: join(TMP, "home"), userDataRoot: join(TMP, "home", ".flywheel") };
const SESSION = "sess-global";
const AGENT: SkillWriteOrigin = { kind: "agent", sessionId: SESSION };
let store: LocalSqliteEventStore;
let writer: SessionFactWriter;
const roots = () => ownedSkillStoreDirs(DIRS);
function registry() {
  return publishSkillRevision(1, loadSkillDefinitions({ roots: [
    { authority: "external", dir: roots().project, reach: "project" },
    { authority: "external", dir: roots().user, reach: "global" },
  ] }).skills);
}
function skillManage(origin: SkillWriteOrigin = AGENT) {
  return createSkillManageTool({ origin, registry, userDataRoot: DIRS.userDataRoot, store: asAsyncEventReadSurface(store), sessionId: SESSION });
}
function context(toolUseId: string): ToolContext {
  return { executionCwd: CWD, userDataRoot: `${CWD}/.test-account`, projectRoot: CWD, toolUseId, artifactScopeId: SESSION, retrievalSessionId: SESSION, sessionId: SESSION, conversationId: "conv-1", sessionEventWriter: writer };
}
function installGlobalSkill(managed = "flywheel") {
  const dir = join(roots().user, "global-notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE), `---\ndescription: Use for global notes.\nmanaged: ${managed}\n---\nAlpha.\n`);
  return dir;
}
const input = { action: "save", name: "global-notes", description: "Use for global notes.", body: "Body.", reach: "global" };
beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  store = createSqliteEventStore(join(TMP, "flywheel.sqlite"));
  writer = createSessionFactWriter({ sessionId: SESSION, writer: asAsyncEventWriter(store) });
});
afterEach(() => { writer.dispose(); store.close(); });

it("applies every interactive global mutation in one call and identifies its scope", async () => {
  const calls = [
    input,
    { ...input, body: "Alpha." },
    { action: "patch", name: input.name, old_string: "Alpha.", new_string: "Beta." },
    { action: "save", name: input.name, path: "references/note.md", content: "Note." },
    { action: "remove_file", name: input.name, path: "references/note.md" },
    { action: "archive", name: input.name },
    { action: "restore", name: input.name, reach: "global" },
  ];
  for (const [index, call] of calls.entries()) {
    const result = await skillManage().execute(call, context(`call-${index}`));
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("Reach: global");
    expect(result.content).not.toContain("confirmation_id");
  }
  expect(readFileSync(join(roots().user, input.name, SKILL_FILE), "utf8")).toContain("Beta.");
  expect(existsSync(join(roots().user, input.name, "references/note.md"))).toBe(false);
  expect((await loadAgentInputProjection(asAsyncEventReadSurface(store), SESSION)).size).toBe(0);
  const facts = [...store.read({ aggregateId: `session:${SESSION}`, types: ["skill.written"] })];
  expect(facts).toHaveLength(calls.length);
  for (const fact of facts) expect(fact).toMatchObject({ type: "skill.written", payload: { reach: "global" } });
});

it("keeps project writes autonomous", async () => {
  const result = await skillManage().execute({ ...input, reach: "project" }, context("project"));
  expect(result.outcome).toBe("ok");
  expect(result.content).toContain("Reach: project");
  expect(existsSync(join(roots().project, input.name, SKILL_FILE))).toBe(true);
  expect((await loadAgentInputProjection(asAsyncEventReadSurface(store), SESSION)).size).toBe(0);
});

it("does not expose a confirmation field in the tool schema", () => {
  expect(JSON.stringify(skillManage().inputSchema)).not.toContain("confirmation_id");
});

it("refuses background writes to managed user packages", async () => {
  const dir = installGlobalSkill("user");
  expect((await skillManage({ kind: "review", reviewRunId: "review", loadedSkillIds: new Set([input.name]) }).execute({ ...input, body: "Replacement." }, context("write"))).outcome).toBe("error");
  expect(readFileSync(join(dir, SKILL_FILE), "utf8")).toContain("Alpha.");
});

it.each(["review", "pruner"] as const)("keeps %s writes out of the global store", async (kind) => {
  const dir = installGlobalSkill();
  const origin: SkillWriteOrigin = kind === "review"
    ? { kind, reviewRunId: "review", loadedSkillIds: new Set([input.name]) }
    : { kind };
  const tool = skillManage(origin);
  for (const call of [
    { ...input, name: "global-new" },
    input,
    { action: "patch", name: input.name, old_string: "Alpha.", new_string: "Beta." },
    { action: "save", name: input.name, path: "references/note.md", content: "Note." },
    { action: "remove_file", name: input.name, path: "references/note.md" },
    { action: "archive", name: input.name, absorbed_into: "other" },
    { action: "restore", name: input.name, reach: "global" },
  ]) expect((await tool.execute(call, context("background"))).outcome).toBe("error");
  expect(readFileSync(join(dir, SKILL_FILE), "utf8")).toContain("Alpha.");
  expect(existsSync(join(roots().user, "global-new"))).toBe(false);
});

it("retains the exact filtered patch in the result and callback", async () => {
  const notices: unknown[] = [];
  const tool = createSkillManageTool({ origin: AGENT, registry, userDataRoot: DIRS.userDataRoot, store: asAsyncEventReadSurface(store), sessionId: SESSION, onWritten: (notice) => notices.push(notice) });
  const result = await tool.execute(input, context("patch"));
  expect(result.outcome).toBe("ok");
  const details = Schema.decodeUnknownSync(Schema.Struct({ resultAction: Schema.String, mutationEvidence: MutationEvidenceSchema }))(result.details);
  expect(details.resultAction).toBe("created");
  const read = (hash: string) => asAsyncEventReadSurface(store).readSessionContentNode!(SESSION, hash);
  const page = await readMutationEvidenceFiles(details.mutationEvidence, 0, 128, read);
  if (page.kind !== "available") throw new Error("expected mutation files");
  expect(page.nextOffset).toBeNull();
  expect(page.files).toHaveLength(1);
  const file = page.files[0];
  if (file?.kind !== "display" || file.file.patch.kind !== "retained") throw new Error("expected retained patch");
  const range = await readSessionContentRange(file.file.patch.reference, 0, 64 * 1024, read);
  if (range.kind !== "available") throw new Error("expected patch bytes");
  expect(range.nextOffset).toBeNull();
  expect(Buffer.from(range.base64, "base64").toString()).toContain("Body.");
  expect(details.mutationEvidence.omissions).toBe(0);
  const notice = Schema.decodeUnknownSync(Schema.Struct({
    name: Schema.String, action: Schema.String, reach: Schema.String, mutationEvidence: MutationEvidenceSchema,
  }))(notices[0]);
  expect(notice.mutationEvidence).toEqual(details.mutationEvidence);
  expect(notice.reach).toBe("global");
});

it("refuses recognized credentials before persisting a global operation", async () => {
  const dir = installGlobalSkill();
  mkdirSync(join(dir, "references"));
  writeFileSync(join(dir, "references/keys.md"), ["sk", "proj", "aB3".repeat(12)].join("-"));
  const result = await skillManage().execute({ action: "patch", name: input.name, old_string: "Alpha.", new_string: "Beta." }, context("secret"));
  expect(result.outcome).toBe("error");
  expect(result.content).toContain("contains a recognized credential value");
  expect(existsSync(join(roots().user, ".operations"))).toBe(false);
});

it("allows an unrecognized opaque value", async () => {
  const dir = installGlobalSkill();
  mkdirSync(join(dir, "references"));
  writeFileSync(join(dir, "references/opaque.md"), "credential: aB3dE5fG7hJ9kLmN2pQrS4tUvW6xYz8+");
  expect((await skillManage().execute({ action: "patch", name: input.name, old_string: "Alpha.", new_string: "Beta." }, context("opaque"))).outcome).toBe("ok");
});

it("keeps journal evidence when the session cannot record a landed write", async () => {
  const refusing: SessionFactWriter = { ...writer, record: async (fact) => fact.type === "skill.written" ? null : writer.record(fact) };
  const result = await skillManage().execute(input, { ...context("write"), sessionEventWriter: refusing });
  expect(result.outcome).toBe("error");
  expect(result.content).toContain("journalled for recovery");
  expect(result.content).toContain("Reach: global.");
  expect(readFileSync(join(roots().user, input.name, SKILL_FILE), "utf8")).toContain("Body.");
  const audit = join(roots().user, ".operations/audit");
  const entries = readdirSync(audit).filter((name) => name.endsWith(".json"));
  expect(entries).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(audit, entries[0]!), "utf8")).fact.type).toBe("skill.written");
});
