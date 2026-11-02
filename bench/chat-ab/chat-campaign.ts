import { join } from "node:path";
import { BASELINE_ARM_ID, loadArm } from "./arms.js";
import { requireAuthProfile, type Args, type PairedArgs } from "./campaign-args.js";
import { runCampaign, type CampaignDesign } from "./campaign-runner.js";
import type { CampaignTreatment } from "./campaign-subject.js";
import { chatFamily } from "./chat-family.js";
import { chatLedger, requireNewChatCampaign, type ChatCampaign } from "./chat-store.js";
import { HARNESS_DIR, RESULTS_ROOT, TASKS_DIR } from "./harness-paths.js";
import { listBenchTasks } from "./tasks.js";
import type { Effort } from "../../src/infra/workflow-types.js";

type StoredTreatment = ChatCampaign["treatments"][number];

/** The values one treatment resolves from, most specific first: a side override, the shared flag, then the resumed manifest. */
interface TreatmentChoice {
  readonly subject: CampaignTreatment["subject"];
  readonly source: string | undefined;
  readonly model: string;
  readonly effort: Effort;
  readonly authProfile: string;
  readonly prior: StoredTreatment | undefined;
}

function chatTreatment(choice: TreatmentChoice): CampaignTreatment {
  const { subject, model, effort, authProfile, prior } = choice;
  if (subject === "claude-code") return { subject, model, effort };
  return { revision: choice.source ?? (prior?.subject === "claude-code" ? undefined : prior?.revision) ?? "HEAD", model, effort, authProfile };
}

/** Chat arms are source/model/profile treatments plus ordinary project skill packages, never provider filters. */
export async function runChatCampaign(args: Args | PairedArgs): Promise<void> {
  const paired = !("arm" in args);
  const directory = args.resume ?? join(RESULTS_ROOT, `chat-${paired ? "paired-" : ""}${new Date().toISOString().replaceAll(":", "-")}`);
  await requireNewChatCampaign(directory);
  const stored = args.resume ? (await chatLedger.open(directory)).manifest : undefined;
  const previous: Partial<ChatCampaign> = stored ?? {};
  const chat = args.chat;
  const model = chat?.model ?? previous.model;
  if (!model) throw new Error("New Chat campaigns require --model; use --source to select a source revision");
  const effort = chat?.effort ?? previous.effort ?? "high";
  const profile = requireAuthProfile(args.authProfile, previous.authProfile);
  const listing = await listBenchTasks(TASKS_DIR);
  const tasks = args.tasks ?? previous.tasks?.map(({ id }) => id) ?? listing.complete;
  if (tasks.length === 0) throw new Error("no tasks selected");
  const treatments: { [id: string]: CampaignTreatment } = {};
  const armIds = new Map<string, string>();
  if ("arm" in args) {
    const prior = stored?.treatments[0];
    const id = prior?.id ?? args.arm;
    treatments[id] = chatTreatment({ subject: chat?.subject ?? prior?.subject, source: chat?.source, model, effort, authProfile: profile, prior });
    armIds.set(id, chat?.arm ?? prior?.arm.id ?? args.arm);
  } else {
    const options = args.chat!;
    for (const side of ["a", "b"] as const) {
      const prior = stored?.treatments.find(({ id }) => id === side);
      const own = side === "a"
        ? { subject: options.aSubject, source: options.aSource, model: options.aModel, profile: options.aProfile, arm: options.aArm }
        : { subject: options.bSubject, source: options.bSource, model: options.bModel, profile: options.bProfile, arm: options.bArm };
      treatments[side] = chatTreatment({
        subject: own.subject ?? options.subject ?? prior?.subject, source: own.source ?? options.source,
        model: own.model ?? chat?.model ?? prior?.model ?? model, effort,
        authProfile: own.profile ?? args.authProfile ?? prior?.authProfile ?? profile, prior,
      });
      armIds.set(side, own.arm ?? options.arm ?? prior?.arm.id ?? BASELINE_ARM_ID);
    }
  }
  const arms = new Map(await Promise.all([...armIds].map(async ([id, arm]) => [id, await loadArm(join(HARNESS_DIR, "arms"), arm)] as const)));
  const design: CampaignDesign = { name: previous.name ?? ("arm" in args ? args.arm : "chat-paired"), tasks, ...(previous.message ? { message: previous.message } : {}), ...(args.challenge ?? previous.challenge ? { challenge: true } : {}), repeats: previous.repeats ?? args.repeats, model, effort, authProfile: profile, treatments };
  await runCampaign({ action: args.resume ? "resume" : "run", results: directory, reservedEvaluation: false, keepSandboxes: args.keepSandboxes, dryRun: args.dryRun }, async () => design, chatFamily(design, arms));
}
