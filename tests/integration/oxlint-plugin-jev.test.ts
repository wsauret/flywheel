import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { temporaryDirectories } from "../helpers/directories.js";
import { startMockDecisionModels, type MockDecisionModels } from "../helpers/mock-decision-models.js";

const repoRoot = resolve(import.meta.dir, "../..");
const oxlintBin = join(repoRoot, "node_modules", "oxlint", "bin", "oxlint");
const pluginSpecifier = join(repoRoot, "scripts", "oxlint-plugin-jev", "src", "index.ts");
const slopConfig = join(repoRoot, "oxlint.slop.config.ts");
const temporaryDirectory = temporaryDirectories();

// The developer's own keys, endpoints, and switches must not reach the linted run.
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "CI" && !/^(?:TYPESAFE_|OPENAI_|ANTI_SLOP_|JEV_)/.test(name)),
);

const lintOutput = z.object({
  diagnostics: z.array(z.object({ code: z.string(), message: z.string() })),
});

interface LintRun {
  readonly exitCode: number;
  readonly stderr: string;
  readonly diagnostics: z.infer<typeof lintOutput>["diagnostics"];
}

let mock: MockDecisionModels | undefined;
afterEach(() => {
  mock?.stop();
  mock = undefined;
});

function startMock(): MockDecisionModels {
  mock = startMockDecisionModels();
  return mock;
}

// The rule blocks oxlint's thread while the worker waits for an answer, so oxlint runs as a child
// process and this process stays free to serve the mock.
interface Fixture {
  readonly source: string;
  /** `jev/ask` rules and options; ignored when `config` names a config file. */
  readonly rules?: readonly object[];
  readonly options?: object;
  /** A config file to lint with instead of a `jev/ask` config. */
  readonly config?: string;
}

const addRule = { id: "adds", target: "function", question: "Does this function add numbers?", cutoff: 0.7 };
const addFixture: Fixture = { source: "export function add(left: number, right: number): number {\n  return left + right;\n}\n" };

async function lint(env: { readonly [name: string]: string }, fixture = addFixture): Promise<LintRun> {
  const dir = temporaryDirectory("fw-jev-");
  writeFileSync(join(dir, "sample.ts"), fixture.source);
  writeFileSync(join(dir, "oxlint.json"), JSON.stringify({
    jsPlugins: [pluginSpecifier],
    plugins: [],
    categories: { correctness: "off" },
    rules: { "jev/ask": ["error", { rules: fixture.rules ?? [addRule], ...fixture.options }] },
  }));
  const child = Bun.spawn([process.execPath, oxlintBin, "-c", fixture.config ?? "oxlint.json", "--format", "json", "sample.ts"], {
    cwd: dir,
    env: { ...inheritedEnv, NAPI_RS_NATIVE_LIBRARY_PATH: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stderr, diagnostics: lintOutput.parse(JSON.parse(stdout)).diagnostics };
}

// Random hex runs at about 1.7 characters per token, far denser than ordinary code.
const hex = (chars: number): string => randomBytes(Math.ceil(chars / 2)).toString("hex").slice(0, chars);

describe("oxlint-plugin-jev", () => {
  it("asks TypeSafe when only TYPESAFE_API_KEY is set, and reports at the cutoff", async () => {
    const server = startMock();
    server.answerWith(0.7);
    const run = await lint({ TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.origin });
    expect(server.requests).toEqual([{ path: "/v1/systemone", model: "jev-latest", bearer: true, questions: 1 }]);
    expect(run.diagnostics.map(({ code, message }) => ({ code, message }))).toEqual([
      { code: "jev(ask)", message: "[adds] jev-mock answered yes (0.70 >= 0.70): Does this function add numbers?" },
    ]);
  });

  it("asks OpenAI Decisions for gpt-6-luna when only OPENAI_API_KEY is set", async () => {
    const server = startMock();
    const run = await lint({ OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `${server.origin}/v1` });
    expect(server.requests).toEqual([{ path: "/v1/decisions", model: "gpt-6-luna", bearer: true, questions: 1 }]);
    expect(run.diagnostics.map(({ message }) => message)).toEqual([
      "[adds] gpt-6-luna-mock answered yes (0.90 >= 0.70): Does this function add numbers?",
    ]);
  });

  it("lets ANTI_SLOP_DECISION_MODEL pick OpenAI over a set TypeSafe key, and stays silent below the cutoff", async () => {
    const server = startMock();
    server.answerWith(0.69);
    const run = await lint({
      ANTI_SLOP_DECISION_MODEL: "openai:gpt-6-luna-test",
      TYPESAFE_API_KEY: "test-key",
      TYPESAFE_BASE_URL: server.origin,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: `${server.origin}/v1`,
    });
    expect(server.requests).toEqual([{ path: "/v1/decisions", model: "gpt-6-luna-test", bearer: true, questions: 1 }]);
    expect(run.diagnostics).toEqual([]);
    expect(run.exitCode).toBe(0);
  });

  it("warns once and skips the bundled presets without a request when no decision credential is set, also under CI", async () => {
    const server = startMock();
    const run = await lint({ CI: "1" }, { ...addFixture, config: slopConfig });
    expect(server.requests).toEqual([]);
    expect(run.diagnostics).toEqual([]);
    expect(run.exitCode).toBe(0);
    const warning = "no decision model credentials: TYPESAFE_API_KEY and OPENAI_API_KEY are both unset, skipping Jev checks";
    expect(run.stderr.split(warning)).toHaveLength(2);
  });

  it("keeps every request of token-dense source under the decision models' 64k-token limit", async () => {
    const server = startMock();
    const source = ["first", "second", "third"].map((name) => `export function ${name}(): string {\n  return "0x${hex(40_000)}";\n}\n`).join("");
    const run = await lint({ TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.origin }, { source, options: { maxSnippetChars: 100_000 } });
    expect(server.requests.map(({ questions }) => questions)).toEqual([2, 1]);
    for (const chars of server.bodyChars) expect(chars).toBeLessThan(64_000 * 1.7);
    expect(run.diagnostics).toHaveLength(3);
  });

  it("gives the split requests and the location refinement of one file a single deadline", async () => {
    const server = startMock();
    server.delayAnswers(1_500);
    // A numbered file over 100,000 characters puts the verdict and the location question in two
    // requests, and its 300 lines make the location answer a range that needs refining.
    const source = Array.from({ length: 300 }, (_, line) => `export const value${line} = "${hex(330)}";\n`).join("");
    const rules = [{
      id: "has-values",
      target: "file",
      question: "Does this file declare constants?",
      cutoff: 0.7,
      location: { question: "Select the first constant.", cutoff: 0.7 },
    }];
    const run = await lint(
      { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.origin },
      { source, rules, options: { maxSnippetChars: 200_000, timeoutMs: 2_500 } },
    );
    expect(server.requests.map(({ questions }) => questions)).toEqual([1, 1]);
    expect(run.stderr).toContain("oxlint-plugin-jev: timeout");
    expect(run.diagnostics).toEqual([]);
  });
});
