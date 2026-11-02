// The options of a chat-ab campaign (bench.ts).
import { resolve } from "node:path";
import { BASELINE_ARM_ID } from "./arms.js";
import { EFFORT_VALUES, type Effort } from "../../src/infra/workflow-types.js";

interface ChatOptions {
  readonly subject?: "flywheel" | "claude-code";
  readonly source?: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly arm?: string;
}
interface PairedChatOptions extends ChatOptions {
  readonly aSubject?: "flywheel" | "claude-code";
  readonly bSubject?: "flywheel" | "claude-code";
  readonly aSource?: string;
  readonly bSource?: string;
  readonly aArm?: string;
  readonly bArm?: string;
  readonly aModel?: string;
  readonly bModel?: string;
  readonly aProfile?: string;
  readonly bProfile?: string;
}

export interface Args {
  readonly challenge?: true;
  readonly arm: string;
  readonly tasks: readonly string[] | undefined;
  readonly repeats: number;
  /** The operator's ordinary auth profile. */
  readonly authProfile: string | undefined;
  readonly dryRun: boolean;
  readonly resume?: string;
  readonly keepSandboxes: boolean;
  readonly chat?: ChatOptions;
}

/** The first auth profile that `choices` names, else the one that `FLYWHEEL_AUTH_PROFILE` names. A benchmark runs on
 *  the profile that its operator chooses, so it refuses to start when none is named. */
export function requireAuthProfile(...choices: readonly (string | undefined)[]): string {
  const profile = [...choices, process.env.FLYWHEEL_AUTH_PROFILE].find((choice) => choice !== undefined && choice !== "");
  if (profile === undefined) throw new Error("--auth-profile is required (or FLYWHEEL_AUTH_PROFILE): a benchmark runs on the auth profile that you choose");
  return profile;
}

/** The flags of one command line: each valued flag's last value, and the switches that are present. */
interface Flags {
  value(flag: string): string | undefined;
  has(flag: string): boolean;
}

/** Reads `--flag value` pairs and bare switches. A flag that the command does not take is an error. */
export function readFlags(argv: readonly string[], valued: readonly string[], switches: readonly string[]): Flags {
  const values = new Map<string, string>();
  const present = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (switches.includes(flag)) present.add(flag);
    else if (valued.includes(flag)) {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      values.set(flag, next);
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return { value: (flag) => values.get(flag), has: (flag) => present.has(flag) };
}

/** The flags that both campaign commands take. */
const COMMON_VALUED = ["--tasks", "--repeats", "--auth-profile", "--resume"] as const;
const COMMON_SWITCHES = ["--dry-run", "--keep-sandboxes", "--challenge"] as const;
const CHAT_VALUED = ["--source", "--model", "--effort", "--subject"] as const;

function chatOptions(flags: Flags): ChatOptions {
  const requested = flags.value("--effort");
  const effort = EFFORT_VALUES.find((value) => value === requested);
  if (requested !== undefined && effort === undefined) throw new Error("--effort is not a supported effort");
  const subject = subjectOption(flags, "--subject");
  return { subject, source: flags.value("--source"), model: flags.value("--model"), effort, arm: flags.value("--arm") };
}

function subjectOption(flags: Flags, flag: string): ChatOptions["subject"] {
  const value = flags.value(flag);
  if (value !== undefined && value !== "flywheel" && value !== "claude-code") throw new Error(`${flag} must be flywheel or claude-code`);
  return value;
}

function requireSubjectArm(subject: ChatOptions["subject"], arm: string | undefined): void {
  if (subject === "claude-code" && arm !== undefined && arm !== BASELINE_ARM_ID) throw new Error("Claude Code treatments require the baseline arm");
}

/** The options that both campaign commands take, with each command's defaults. */
function commonOptions(flags: Flags, repeats: number) {
  const positive = (flag: string, fallback: number) => {
    const text = flags.value(flag);
    const number = text === undefined ? fallback : Number(text);
    if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer`);
    return number;
  };
  const tasks = flags.value("--tasks")?.split(",").map((item) => item.trim()).filter(Boolean);
  const resume = flags.value("--resume");
  return {
    tasks,
    repeats: positive("--repeats", repeats),
    authProfile: flags.value("--auth-profile") ?? (process.env.FLYWHEEL_AUTH_PROFILE || undefined),
    dryRun: flags.has("--dry-run"),
    ...(flags.has("--challenge") ? { challenge: true as const } : {}),
    ...(resume === undefined ? {} : { resume: resolve(resume) }),
    keepSandboxes: flags.has("--keep-sandboxes"),
  };
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = readFlags(argv, [...COMMON_VALUED, ...CHAT_VALUED, "--arm"], COMMON_SWITCHES);
  const common = commonOptions(flags, 2);
  const chat = chatOptions(flags);
  requireSubjectArm(chat.subject, chat.arm);
  return { ...common, arm: flags.value("--arm") ?? BASELINE_ARM_ID, chat };
}

/** Paired treatments run sequentially in rotating ledger order. */
export interface PairedArgs {
  readonly challenge?: true;
  readonly tasks: readonly string[] | undefined;
  readonly repeats: number;
  readonly chat?: PairedChatOptions;
  /** Shared profile unless a treatment names its own. */
  readonly authProfile: string | undefined;
  readonly dryRun: boolean;
  readonly resume?: string;
  readonly keepSandboxes: boolean;
}

export function parsePairedArgs(argv: readonly string[]): PairedArgs {
  const flags = readFlags(argv, [...COMMON_VALUED, ...CHAT_VALUED, "--arm", "--a-source", "--b-source", "--a-subject", "--b-subject", "--a-arm", "--b-arm", "--a-model", "--b-model", "--a-profile", "--b-profile"], COMMON_SWITCHES);
  const common = commonOptions(flags, 4);
  const chat = chatOptions(flags);
  const aSubject = subjectOption(flags, "--a-subject");
  const bSubject = subjectOption(flags, "--b-subject");
  requireSubjectArm(aSubject ?? chat.subject, flags.value("--a-arm") ?? chat.arm);
  requireSubjectArm(bSubject ?? chat.subject, flags.value("--b-arm") ?? chat.arm);
  return { ...common, chat: {
    ...chat, aSubject, bSubject, aSource: flags.value("--a-source"), bSource: flags.value("--b-source"),
    aArm: flags.value("--a-arm"), bArm: flags.value("--b-arm"),
    aModel: flags.value("--a-model"), bModel: flags.value("--b-model"), aProfile: flags.value("--a-profile"), bProfile: flags.value("--b-profile"),
  } };
}
