import type { MutationEvidence } from "../../../infra/mutation-evidence.js";
import type { NotAppliedFilesSummary } from "../../../infra/not-applied-files.js";
import type { CommandHandoverHost } from "../command-handover.js";
import type { ForegroundView } from "./bash-output-tail.js";
import type { PrivateCopyPool } from "./bash-private-copy-pool.js";
import type { RuntimePlatform } from "./bash-script.js";
import type { ShellEnvironment } from "./shell-environment.js";
import type { BashOperations, ToolContext, ToolResult } from "./types.js";

export type OwnedSpawn = NonNullable<ToolContext["spawnOwned"]>;

interface ShellExecutionOptions {
  command: string;
  context: ToolContext;
  spawnOwned: OwnedSpawn;
  env: ShellEnvironment;
  operations: BashOperations;
  platform: RuntimePlatform;
  tempDir: string;
  executionOutputThrottleMs: number;
  /** Present for a command that runs in a private project copy. */
  privateCopy?: PrivateCopy;
}

export interface ManagedShellExecutionOptions extends ShellExecutionOptions {
  /** Whether the tool call holds the command until it settles, the person or
   *  a planned replacement moves it to the background, the runtime cap
   *  passes, or the turn aborts. A held command registers its hold with the
   *  context's controller for its whole run, a launch that has not started
   *  included. A command that is not held transfers at launch. */
  foreground: boolean;
  /** The runtime cap after which a held command transfers to the session
   *  registry. Absent when the command's own deadline is inside the hold
   *  window: the command then holds until it settles or its deadline ends it. */
  totalYieldMs?: number;
  rawOutput: boolean;
  timeoutSec?: number;
  /** How long settlement waits after the exit for the parent-side stderr to end. */
  postExitDrainGraceMs?: number;
  onForegroundSettled?: (settled: { readonly foreground: ForegroundView; readonly executionOutputTail: string }) => void;
}

export interface ForegroundShellExecutionOptions extends ShellExecutionOptions {
  timeoutSec: number;
  rawOutput: boolean;
  postExitDrainGraceMs: number;
}

/** How a command that ran in a private project copy ended. */
export interface ProjectMutationSettlement {
  /** A person, an agent, or runtime teardown stopped the command, so its changes are discarded. */
  readonly interrupted: boolean;
  /** Cancels publication: the turn signal for a foreground command, the background-work signal for a managed one. */
  readonly signal: AbortSignal | undefined;
  /** The command's settled output, where a write the mutation guard denied shows; empty when none was captured. */
  readonly output: string;
}

/** What landing one private copy did. `report` is model-facing text the runner appends to the command's result. */
export interface ProjectMutationLanding {
  readonly report: string;
  /** Recovery and verification failures remain visible beside retained diffs. */
  readonly retainReport?: true;
  /** The files that landed, absent when none did. */
  readonly mutationEvidence?: MutationEvidence;
  /** The bounded notice sample, removed once from display output when the view renders it. */
  readonly notAppliedSummary?: NotAppliedFilesSummary;
}

/** Lands a private copy after its command exits. A shell runner calls it exactly once per launched command. */
type LandProjectMutation = (settlement: ProjectMutationSettlement) => Promise<ProjectMutationLanding>;

/** The private project copy one command runs in, and the step that lands it. */
export interface PrivateCopy {
  /** The directory that holds everything the copy owns, the command's changes
   *  and the copy's record among them, from which a later build that adopts
   *  the command lands the copy. */
  readonly home: string;
  /** Called once after the command exits and before its result or completion exists. */
  readonly land: LandProjectMutation;
  /** Keeps the copy out of its session's pool from now on, for a copy whose
   *  home a handover row names: a later build can land the copy from that
   *  home, so the landing here deletes it. Absent for a copy a previous build
   *  handed over, which no pool holds. */
  readonly withhold?: () => void;
}

export interface ShellRuntimeClient {
  /** Reads this owner's unfinished foreground calls and managed shell processes, including stopping processes. */
  hasActiveCommands(): boolean;
  runForeground(options: ForegroundShellExecutionOptions): Promise<ToolResult>;
  runBackground(options: ManagedShellExecutionOptions): Promise<ToolResult>;
  /** The idle private copies this session's mutating commands reuse. */
  readonly privateCopies: PrivateCopyPool;
}

export interface ShellRuntime {
  readonly client: ShellRuntimeClient;
  /** Hands every running managed command to the next build, for a host that
   *  closes for a planned replacement. Runs before the registry ends what
   *  remains. */
  handOver(host: CommandHandoverHost): Promise<void>;
  /** Adopts every command a previous build handed to the host's
   *  conversation that the host does not hold yet, from the executor's
   *  keeper where it holds one, and answers how many rows it left for a
   *  later attempt. `quiet` marks a repeated attempt, which reports only at
   *  debug. */
  adopt(host: CommandHandoverHost, quiet?: boolean): Promise<number>;
  close(): Promise<void>;
}
