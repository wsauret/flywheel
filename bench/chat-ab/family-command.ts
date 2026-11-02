// The command line that every campaign family shares:
//   <command> plan|setup|run|resume <design.json> --results <dir>
//   <command> report <results-dir>
//   <command> judge <results-dir> --auth-profile <profile> [--a <id> --b <id>] [--dry-run]
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requireAuthProfile } from "./campaign-args.js";
import { parseCodingDesign, type CodingDesign } from "./coding-ab-design.js";
import type { CampaignManifest, CampaignOutcome } from "./campaign-store.js";
import { runCampaign, type CampaignFamily } from "./campaign-runner.js";
import { RESULTS_ROOT } from "./harness-paths.js";

const ACTIONS = ["plan", "setup", "run", "resume", "report", "judge"] as const;

interface FamilyOptions {
  action: typeof ACTIONS[number];
  /** The design file, or the results directory of `report` and `judge`. */
  input: string;
  results: string;
  reservedEvaluation: boolean;
  keepSandboxes: boolean;
  dryRun: boolean;
  a?: string;
  b?: string;
  authProfile?: string;
}

interface FamilyJudgeInput {
  readonly directory: string;
  readonly a: string | undefined;
  readonly b: string | undefined;
  readonly authProfile: string;
  readonly dryRun: boolean;
}

export interface FamilyCommand<Task extends { readonly id: string }, Grade extends object, Manifest extends CampaignManifest, Outcome extends CampaignOutcome, Judgement> {
  /** The script name that the usage line shows. */
  readonly usage: string;
  readonly family: (design: CodingDesign) => CampaignFamily<Task, Grade, Manifest, Outcome>;
  readonly report: (directory: string) => Promise<string>;
  /** Its result is printed as JSON. */
  readonly judge: (input: FamilyJudgeInput) => Promise<Judgement>;
  /** Whether the family takes `--reserved-evaluation`. */
  readonly reservedEvaluation?: true;
}

/** Parse one command line. Refuses an unknown action or flag, a flag without its value, and a campaign action that
 *  would write into the shared results root. */
export function familyCommandOptions(argv: readonly string[], usage: string, reservedEvaluation = false): FamilyOptions {
  const [requested, input, ...flags] = argv;
  const action = ACTIONS.find((value) => value === requested);
  if (!action || !input) throw new Error(`Usage: ${usage} plan|setup|run|resume <design.json> --results <dir>, or report|judge <results-dir>`);
  const options: FamilyOptions = { action, input: resolve(input), results: RESULTS_ROOT, reservedEvaluation: false, keepSandboxes: false, dryRun: false };
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    const value = () => {
      const next = flags[++index];
      if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--results") options.results = resolve(value());
    else if (flag === "--reserved-evaluation" && reservedEvaluation) options.reservedEvaluation = true;
    else if (flag === "--keep-sandboxes") options.keepSandboxes = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--a") options.a = value();
    else if (flag === "--b") options.b = value();
    else if (flag === "--auth-profile") options.authProfile = value();
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (["setup", "run", "resume"].includes(action) && options.results === RESULTS_ROOT) throw new Error("Use --results with a dedicated campaign directory");
  return options;
}

async function execute<Task extends { readonly id: string }, Grade extends object, Manifest extends CampaignManifest, Outcome extends CampaignOutcome, Judgement>(
  argv: readonly string[], command: FamilyCommand<Task, Grade, Manifest, Outcome, Judgement>,
): Promise<void> {
  const options = familyCommandOptions(argv, command.usage, command.reservedEvaluation === true);
  const { action, input } = options;
  if (action === "report") console.log(await command.report(input));
  else if (action === "judge") {
    console.log(JSON.stringify(await command.judge({ directory: input, a: options.a, b: options.b, authProfile: requireAuthProfile(options.authProfile), dryRun: options.dryRun }), null, 2));
  } else {
    const design = parseCodingDesign(JSON.parse(await readFile(input, "utf8")), options.authProfile);
    await runCampaign({ ...options, action }, async () => design, command.family(design));
  }
}

/** Run one family command line and report a failure as its message and exit code 1. */
export function runFamilyCommand<Task extends { readonly id: string }, Grade extends object, Manifest extends CampaignManifest, Outcome extends CampaignOutcome, Judgement>(
  argv: readonly string[], command: FamilyCommand<Task, Grade, Manifest, Outcome, Judgement>,
): void {
  execute(argv, command).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
