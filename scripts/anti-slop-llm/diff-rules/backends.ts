// oxlint-disable anti-slop/no-unknown-returns, flywheel/no-record, typescript/consistent-indexed-object-style -- vendored upstream source keeps its own style; see UPSTREAM.md
import { experimental_decide } from "ai";
import { chooseDecisionBackend } from "../../oxlint-plugin-jev/src/backend.ts";
import { decisionModelFor, decisionProviderOptions } from "../../oxlint-plugin-jev/src/decision-model.ts";
import type { Backend as DecisionBackend } from "../../oxlint-plugin-jev/src/types.ts";
import { shellCommandLaunch } from "../../../src/infra/shell-command.ts";
import { withOwnedCommands } from "../owned-commands.ts";
import type { BackendName, ResolvedConfig } from "./config.ts";
import { renderJudgePrompt, type JudgeInput } from "./input.ts";
import type { DiffRule } from "./rules.ts";

export interface RuleAnswer {
  readonly id: string;
  /** Probability (decision model) or confidence-derived probability (command judge) of YES. */
  readonly probability: number;
  readonly evidence?: string;
  readonly files?: ReadonlyArray<string>;
  /** The model that answered, as the backend reports it. */
  readonly model: string;
}

export interface Backend {
  readonly name: BackendName;
  /** Backend identity for the cache key: name plus endpoint or command. */
  readonly identity: string;
  /** The requested model or command; answers report the model that actually answered. */
  readonly model: string;
  ask(rules: ReadonlyArray<DiffRule>, input: JudgeInput): Promise<ReadonlyArray<RuleAnswer>>;
}

export type BackendChoice =
  | { readonly ok: true; readonly backend: Backend }
  | { readonly ok: false; readonly name: BackendName; readonly reason: string };

type Env = Readonly<Record<string, string | undefined>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One line per failure: the status code and provider message, without the SDK's request dump. */
function describeAiError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // RetryError keeps every attempt's error; the last one has the status and provider message.
  const errors: ReadonlyArray<unknown> | undefined = isRecord(error) && Array.isArray(error.errors) ? error.errors : undefined;
  const last = errors?.at(-1);
  const source = last instanceof Error ? last : error;
  const status = isRecord(source) && typeof source.statusCode === "number" ? source.statusCode : undefined;
  const attempts = errors === undefined || errors.length < 2 ? "" : ` (after ${errors.length} attempts)`;
  return `${status === undefined ? "" : `http ${status}: `}${source.message}${attempts}`;
}

/** The AI SDK retries 408, 409, 429, 5xx, and connection errors, honoring `retry-after-ms` and `Retry-After`. */
const MAX_RETRIES = 2;

// --- Decision model: TypeSafe Jev or OpenAI Decisions through `experimental_decide` ---

export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

const questionRef = (index: number): string => `r${index}`;

export function decisionModelBackend(options: {
  readonly target: DecisionBackend;
  /** The plugin's backend id: provider, endpoint, and model. */
  readonly id: string;
  readonly timeoutMs: number;
}): Backend {
  const { target } = options;
  const longContext = target.kind === "typesafe" && target.longContext;
  return {
    name: "decision-model",
    identity: `decision-model ${options.id}${longContext ? " long-context" : ""}`,
    model: target.model,
    async ask(rules, input) {
      let result;
      try {
        result = await experimental_decide({
          model: decisionModelFor(target),
          state: input.text,
          questions: Object.fromEntries(
            rules.map((rule, index) => [questionRef(index), { type: "boolean" as const, instructions: rule.question }]),
          ),
          maxRetries: MAX_RETRIES,
          abortSignal: AbortSignal.timeout(options.timeoutMs),
          providerOptions: decisionProviderOptions(target),
        });
      } catch (error) {
        throw new Error(describeAiError(error), { cause: error });
      }
      const answered = result.response.modelId;
      return rules.map((rule, index) => {
        const answer = result.answers[questionRef(index)];
        const probability = answer?.type === "boolean" ? answer.probability : undefined;
        if (probability === undefined || !(probability >= 0 && probability <= 1)) {
          throw new Error(`decision model response has no probability in [0, 1] for "${rule.id}"`);
        }
        return { id: rule.id, probability, model: answered };
      });
    },
  };
}

// --- Parsing judge replies for the `command` backend ---

/** Find the JSON object in a model reply that may add prose or code fences around it. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error(`judge reply has no JSON object: ${trimmed.slice(0, 200)}`);
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (error) {
      throw new Error(`judge reply is not valid JSON: ${trimmed.slice(0, 200)}`, { cause: error });
    }
  }
}

/** Validate `{ rules: [{ id, violation, confidence, evidence, files }] }` for every asked rule. */
export function parseJudgeAnswers(json: unknown, rules: ReadonlyArray<DiffRule>, model: string): RuleAnswer[] {
  // Agent CLIs with JSON output wrap the reply text in `{ result }`.
  if (isRecord(json) && !("rules" in json) && typeof json.result === "string") {
    return parseJudgeAnswers(extractJsonObject(json.result), rules, model);
  }
  if (!isRecord(json) || !Array.isArray(json.rules)) throw new Error("judge reply has no rules list");
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of json.rules) {
    if (isRecord(entry) && typeof entry.id === "string") byId.set(entry.id, entry);
  }
  return rules.map((rule) => {
    const entry = byId.get(rule.id);
    if (entry === undefined) throw new Error(`judge reply has no answer for "${rule.id}"`);
    const { violation, confidence, evidence, files } = entry;
    if (typeof violation !== "boolean") throw new Error(`judge answer for "${rule.id}" has no boolean violation`);
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
      throw new Error(`judge answer for "${rule.id}" has no confidence in [0, 1]`);
    }
    if (evidence !== undefined && typeof evidence !== "string") {
      throw new Error(`judge answer for "${rule.id}" has non-string evidence`);
    }
    if (files !== undefined && !(Array.isArray(files) && files.every((file) => typeof file === "string"))) {
      throw new Error(`judge answer for "${rule.id}" has files that are not a list of paths`);
    }
    return {
      id: rule.id,
      probability: violation ? confidence : 1 - confidence,
      ...(evidence === undefined || evidence.length === 0 ? {} : { evidence }),
      ...(files === undefined ? {} : { files }),
      model,
    };
  });
}

// The command runs in an owned container, so a timeout ends every process it started, such as
// each side of a pipeline, and the result settles only after they are gone.
async function runCommand(command: string, stdin: string, timeoutMs: number): Promise<string> {
  const { argv, env } = shellCommandLaunch(command);
  const result = await withOwnedCommands((run) => run(argv, { stdin, timeoutMs, env }));
  if (result.timedOut) throw new Error(`judge command timed out after ${timeoutMs}ms`);
  if (result.exitCode !== 0) {
    throw new Error(`judge command exited with ${String(result.exitCode)}: ${result.stderr.trim().slice(-500)}`);
  }
  return result.stdout;
}

export function commandBackend(options: { readonly command: string; readonly timeoutMs: number }): Backend {
  return {
    name: "command",
    identity: `command ${options.command}`,
    model: options.command,
    async ask(rules, input) {
      const stdout = await runCommand(options.command, renderJudgePrompt(rules, input), options.timeoutMs);
      return parseJudgeAnswers(extractJsonObject(stdout), rules, options.command);
    },
  };
}

/** Build the requested backend, or the decision model when it has credentials and none is requested. */
export function chooseBackend(
  requested: BackendName | undefined,
  config: ResolvedConfig,
  env: Env,
  overrides: { readonly command?: string },
): BackendChoice {
  const command = overrides.command ?? config.command;
  const decision = chooseDecisionBackend(env, { typesafeModel: TYPESAFE_DEFAULT_MODEL, longContext: config.longContext });
  const name: BackendName = requested ?? config.backend ?? (decision.ok || command === undefined ? "decision-model" : "command");
  if (name === "decision-model") {
    if (!decision.ok) return { ok: false, name, reason: decision.reason };
    return { ok: true, backend: decisionModelBackend({ target: decision.backend, id: decision.id, timeoutMs: config.timeoutMs }) };
  }
  if (command === undefined) {
    return { ok: false, name, reason: "no judge command: pass --command or set command in the config" };
  }
  return { ok: true, backend: commandBackend({ command, timeoutMs: config.timeoutMs }) };
}
