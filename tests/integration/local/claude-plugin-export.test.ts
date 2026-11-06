/**
 * The Claude plugin that a release ships, loaded by the bundled engine binary that Flywheel itself runs.
 *
 * Each run points the engine at a fake model endpoint and records what the engine sends: its system prompt, its
 * tools, and what a scripted Skill or Agent call puts in the conversation. That is the only place where it shows
 * how the host reads the plugin, so these assertions are the proof that the export reaches the model as built.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enginePath } from "../../../src/infra/claude-engine.js";
import { parseFrontmatter } from "../../../src/infra/frontmatter.js";
import { buildClaudePlugin, writePluginDirectory } from "../../../scripts/build-claude-plugin.js";
import { CLAUDE_MARKETPLACE_FILE, claudeMarketplace } from "../../../scripts/release-contract.js";
import { zipArchive } from "../../../scripts/zip-archive.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { declaredTools, startFakeHost, type FakeReply, type RecordedRequest } from "../orchestration/modules/provider-claude-agent-sdk/_fake-host.js";

const temporary = temporaryDirectories();
const plugin = buildClaudePlugin("9.8.7", "Plugin Author");
const INTENT = "Purpose: the probe change keeps every reply under ten words.";

function body(path: string): string {
  const parsed = parseFrontmatter(plugin.files.get(path) ?? "");
  if (parsed === null) throw new Error(`${path} has no frontmatter`);
  return parsed.body.trim();
}
function match(pattern: RegExp, text: string): string {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`The plugin text has no match for ${pattern.source}`);
  return found;
}

// The test calls the skill and the agent that the exported text itself names, the way the model reads them: the
// main agent's design skill, and a reviewer of the code-review skill with that skill's dispatch template, filled in.
const SKILL = match(/load the `(flywheel:[a-z-]+)` skill/, body("agents/flywheel.md"));
const reviewText = body(`skills/${match(/load the `flywheel:([a-z-]+)` skill and run its review/, body("agents/flywheel.md"))}/SKILL.md`);
const AGENT = match(/`flywheel:(reviewer-[a-z-]+)`/, reviewText);
const REVIEW_PROMPT = match(/```text\n(Review this completed change\.[^`]*)```/, reviewText)
  .replace("[the approved Design intent and the user's dated decisions, verbatim]", INTENT);

interface TextBlock { readonly type: string; readonly text?: string }
interface Message { readonly role: string; readonly content: string | readonly TextBlock[] }

function systemBlocks(request: RecordedRequest): readonly string[] {
  const system = request.body["system"];
  return Array.isArray(system) ? system.map((block: TextBlock) => block.text ?? "") : [];
}
function conversation(request: RecordedRequest): string {
  return JSON.stringify(request.body["messages"]);
}
function blocks(request: RecordedRequest): readonly TextBlock[] {
  const messages: unknown = request.body["messages"];
  const list: readonly Message[] = Array.isArray(messages) ? messages : [];
  return list.flatMap((message) => typeof message.content === "string" ? [] : message.content);
}
function toolResults(request: RecordedRequest): number {
  return blocks(request).filter((block) => block.type === "tool_result").length;
}

/** One print-mode turn of the engine with `pluginPath`, if any, against a fake endpoint that answers with `reply`. */
async function runEngine(pluginPath: string | undefined, reply: (request: RecordedRequest) => FakeReply): Promise<readonly RecordedRequest[]> {
  const root = temporary("flywheel-claude-plugin-");
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  const host = startFakeHost(reply);
  try {
    const engine = Bun.spawn([enginePath(), "-p", "hello", ...(pluginPath === undefined ? [] : ["--plugin-dir", pluginPath])], {
      cwd: project,
      env: {
        PATH: process.env["PATH"] ?? "",
        TMPDIR: process.env["TMPDIR"] ?? root,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(root, "config"),
        ANTHROPIC_API_KEY: "sk-ant-fake-endpoint",
        CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_TELEMETRY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...host.environment,
      },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [code, stderr] = await Promise.all([engine.exited, new Response(engine.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(host.trapped).toEqual([]);
    return host.requests;
  } finally {
    await host.stop();
  }
}

const answer: FakeReply = { blocks: [{ text: "done" }] };

describe("the Claude plugin in the bundled engine", () => {
  it("replaces the main prompt, keeps the native tools, and delivers its skills and agents", async () => {
    const root = temporary("flywheel-claude-plugin-build-");
    const dir = join(root, "plugin");
    writePluginDirectory(plugin, dir);
    const zip = join(root, "plugin.zip");
    writeFileSync(zip, zipArchive(plugin.files));

    const personaBody = body(`agents/${AGENT}.md`);
    // The engine appends its own notes for a subagent after the agent's body.
    const isSubagent = (request: RecordedRequest): boolean => systemBlocks(request)[2]?.startsWith(`${personaBody}\n`) === true;
    const [baseline] = await runEngine(undefined, () => answer);
    const [fromZip] = await runEngine(zip, () => answer);
    const scripted = await runEngine(dir, (request) => {
      if (isSubagent(request)) return answer;
      const results = toolResults(request);
      if (results === 0) return { blocks: [{ tool: "Skill", input: { skill: SKILL } }] };
      if (results === 1) return { blocks: [{ tool: "Agent", input: { description: "review", prompt: REVIEW_PROMPT, subagent_type: `flywheel:${AGENT}`, run_in_background: false } }] };
      return answer;
    });

    const mainBody = body("agents/flywheel.md");
    const [main] = scripted;
    const afterSkill = scripted.find((request) => toolResults(request) === 1 && !isSubagent(request));
    const subagent = scripted.find(isSubagent);
    if (baseline === undefined || fromZip === undefined || main === undefined || afterSkill === undefined || subagent === undefined) {
      throw new Error("The engine did not send every expected model request");
    }
    // The engine's identity line and its billing line come first; the plugin's main agent replaces everything after.
    expect(systemBlocks(main).slice(2)).toEqual([mainBody]);
    expect(systemBlocks(fromZip).slice(2)).toEqual([mainBody]);
    expect(declaredTools(main.body)).toEqual(declaredTools(baseline.body));

    const listing = conversation(main);
    for (const path of plugin.files.keys()) {
      const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1];
      if (skill !== undefined) expect(listing).toContain(`flywheel:${skill}`);
      const agent = /^agents\/([^/]+)\.md$/.exec(path)?.[1];
      if (agent !== undefined && agent !== "flywheel") expect(listing).toContain(`flywheel:${agent}`);
    }

    expect(blocks(afterSkill).some((block) => block.text?.trimEnd().endsWith(body(`skills/${SKILL.replace("flywheel:", "")}/SKILL.md`)) === true)).toBe(true);

    const persona = parseFrontmatter(plugin.files.get(`agents/${AGENT}.md`) ?? "")?.frontmatter;
    expect(String(subagent.body["model"])).toContain(String(persona?.["model"]));
    expect(declaredTools(subagent.body)).toEqual(String(persona?.["tools"]).split(", "));
    // The host carries nothing of the parent's conversation to the agent: the filled template is how the intent arrives.
    expect(conversation(subagent)).toContain(INTENT);
  }, 180_000);

  it("passes the engine's own validation, as a plugin and as the release marketplace", async () => {
    const root = temporary("flywheel-claude-plugin-validate-");
    const dir = join(root, "plugin");
    writePluginDirectory(plugin, dir);
    const marketplace = join(root, "marketplace");
    mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
    writeFileSync(join(marketplace, CLAUDE_MARKETPLACE_FILE), claudeMarketplace("wsauret/flywheel", "9.8.7", "Plugin Author", "0".repeat(64)));
    for (const target of [dir, marketplace]) {
      const validate = Bun.spawn([enginePath(), "plugin", "validate", "--json", target], {
        cwd: root,
        env: { PATH: process.env["PATH"] ?? "", HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "config") },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      const [code, stdout] = await Promise.all([validate.exited, new Response(validate.stdout).text()]);
      expect({ target, code }).toEqual({ target, code: 0 });
      expect(JSON.parse(stdout)).toMatchObject({ success: true, manifest: { errors: [] } });
    }
  }, 60_000);
});
