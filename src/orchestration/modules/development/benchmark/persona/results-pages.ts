import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectStartupDirectories } from "../../../../../infra/platform/files/directory-authorities.js";
import { getPersonaMetadataIndex } from "../../../../../workflows/agents/agent-roles.js";
import { modelPriceTier } from "../../../../config/models/model-tiers.js";
import { ROLE_MODEL_DEFAULTS, roleModelDefault } from "../../../../config/models/role-model-defaults.js";
import { currentGrade, judgeLabel, loadAllCampaignRecords, type CampaignRecords, type CellLine, type RecordJudge, type ScoreLine } from "../records/benchmark-records.js";
import { benchmarkMode, type BenchmarkCatalog, type BenchmarkMode } from "../catalog.js";
import type { BenchmarkAccounting } from "../accounting/evidence.js";
import { planTasks, scoringVersion } from "./persona-benchmark.js";
import { byCodeUnit, cellStanding, median, rankBenchmarkRecords, rankingCorpus, renderRoleRanking, RULE, staleTask, type RankingCorpus, type RankingFamily, type RankingInput, type RankingTask } from "../records/ranking.js";
import { combineBenchmarkAccounting } from "../accounting/report-accounting.js";

// The results page of each benchmarked persona (ARCH-DIRECTORIES-023): its role's ranking under every judge that
// scored a current cell of it, every recorded cell by task and setting, per-setting totals, coverage gaps, cells to
// retry, and the campaigns behind it. A page is generated from record files and the catalog alone and holds no
// generation time, so the same records always give the same bytes and lint can fail a page that differs.

const FAMILIES: readonly RankingFamily[] = ["openai", "anthropic"];
const REGENERATE = "bun run bench:tables";

/** The ranking input of every persona with records, as `bench:rank` and the results pages read it. Prices come from
 *  the bundled models document only, so every clone classifies a model the same way. */
export async function loadRankingInput(catalog: BenchmarkCatalog): Promise<RankingInput> {
  const campaigns = await loadAllCampaignRecords(catalog.recordsRoot);
  const personas = getPersonaMetadataIndex();
  const corpora = new Map<string, RankingCorpus>();
  for (const persona of new Set(campaigns.map(({ header }) => header.persona))) {
    const mode = benchmarkMode(persona);
    corpora.set(persona, rankingCorpus(persona, mode, await planTasks(persona, mode, catalog)));
  }
  const { userDataRoot } = selectStartupDirectories({ projectRootOption: catalog.projectRoot, env: process.env, cwd: catalog.projectRoot });
  // SAFETY: roleModelDefault returns one of the ROLE_MODEL_DEFAULTS entries, so the search always finds it.
  const entryOf = (role: string) => Object.entries(ROLE_MODEL_DEFAULTS).find(([, entry]) => entry === roleModelDefault(role))![0];
  return {
    campaigns,
    roleOf: (persona) => personas[persona]?.role,
    corpora,
    scoringVersion,
    classify: (model) => {
      for (const family of FAMILIES) {
        const tier = modelPriceTier(model, family, { userDataRoot }, ["bundled"]);
        if (tier !== "default") return { family, tier };
      }
      return { family: undefined, tier: undefined };
    },
    entryOf,
  };
}

/** The results page of every persona with records, keyed by persona, in persona order. */
export function renderResultsPages(input: RankingInput): ReadonlyMap<string, string> {
  const personas = [...new Set(input.campaigns.map(({ header }) => header.persona))].sort(byCodeUnit);
  return new Map(personas.map((persona) => [persona, renderResultsPage(persona, input)]));
}

/** Write each page that is missing or differs under `tablesRoot`, and return the files written. */
export async function writeResultsPages(tablesRoot: string, pages: ReadonlyMap<string, string>): Promise<string[]> {
  const written: string[] = [];
  for (const [persona, text] of pages) {
    const file = join(tablesRoot, `${persona}.md`);
    if (await readPage(file) === text) continue;
    await mkdir(tablesRoot, { recursive: true });
    await writeFile(file, text);
    written.push(file);
  }
  return written;
}

/** One line per page under `tablesRoot` that is missing or differs from `pages`; empty when every page is current. */
export async function staleResultsPages(tablesRoot: string, pages: ReadonlyMap<string, string>): Promise<string[]> {
  const stale: string[] = [];
  for (const [persona, text] of pages) {
    const file = join(tablesRoot, `${persona}.md`);
    const committed = await readPage(file);
    if (committed !== text) stale.push(`${file} is ${committed === undefined ? "missing" : "stale"}`);
  }
  return stale;
}

/** Regenerate every results page from the records of `catalog`, as each command that appends records does when it
 *  finishes. Returns the files written. */
export async function publishResultsPages(catalog: BenchmarkCatalog): Promise<string[]> {
  return await writeResultsPages(catalog.tablesRoot, renderResultsPages(await loadRankingInput(catalog)));
}

async function readPage(file: string): Promise<string | undefined> {
  return await readFile(file, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
}

/** One recorded cell with its campaign. */
interface Entry {
  readonly campaign: CampaignRecords;
  readonly cell: CellLine;
}

function sameJudge(a: RecordJudge, b: RecordJudge): boolean {
  return a.model === b.model && a.effort === b.effort;
}

function sameSeat(a: { variant: string; task: string; repeat: number }, b: { variant: string; task: string; repeat: number }): boolean {
  return a.variant === b.variant && a.task === b.task && a.repeat === b.repeat;
}

/** The judges that scored a current cell of the persona under the current contract, the most cells first. */
function personaJudges(campaigns: readonly CampaignRecords[], corpus: RankingCorpus, version: string): RecordJudge[] {
  const counts = new Map<string, { judge: RecordJudge; cells: number }>();
  for (const campaign of campaigns) {
    for (const line of campaign.scores) {
      if (line.scoringVersion !== version) continue;
      const cell = campaign.cells.find((candidate) => sameSeat(candidate, line.score));
      if (!cell || "reason" in cellStanding(cell, campaign, corpus, line.judge, version)) continue;
      const key = judgeLabel(line.judge);
      counts.set(key, { judge: line.judge, cells: (counts.get(key)?.cells ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.cells - a.cells || byCodeUnit(judgeLabel(a.judge), judgeLabel(b.judge))).map(({ judge }) => judge);
}

/** The hidden-test grade a cell shows: its recorded grade while its task is current, otherwise the current grader's
 *  grade, then the latest regrade, then the recorded grade. Only the first two are grades that a ranking pools. */
function implementationGrade(entry: Entry, task: RankingTask | undefined): { passed: number; total: number } | undefined {
  const { campaign, cell } = entry;
  if (cell.output.kind !== "implementation") return undefined;
  const recorded = { passed: cell.output.acceptancePassed, total: cell.output.acceptanceTotal };
  if (task?.contentIdentity === cell.taskIdentity) return recorded;
  const current = task?.implementation ? currentGrade(campaign, cell, task.implementation.graderIdentity) : undefined;
  return current ?? campaign.grades.filter((grade) => sameSeat(grade, cell)).at(-1) ?? recorded;
}

function scoreOf(entry: Entry, judge: RecordJudge, version: string): ScoreLine | undefined {
  return entry.campaign.scores.find((line) => line.scoringVersion === version && sameJudge(line.judge, judge) && sameSeat(line.score, entry.cell));
}

/** One cell in the matrix. The implementer shows its grade; a reviewer or the explorer shows `judge`'s measure. */
function cellToken(entry: Entry, task: RankingTask | undefined, corpus: RankingCorpus, mode: BenchmarkMode, judge: RecordJudge | undefined, version: string): string {
  const stale = staleTask(entry.cell, entry.campaign, corpus) === undefined ? "" : "*";
  if (mode === "implement") {
    const grade = implementationGrade(entry, task);
    if (!grade) return `T${stale}`;
    return `${grade.passed === grade.total ? "P" : `F(${grade.passed}/${grade.total})`}${stale}`;
  }
  // SAFETY: a reviewer and a research page render one matrix per judge, so `judge` is set here.
  const score = scoreOf(entry, judge!, version);
  if (!score || score.scorer === "trap") return `?${stale}`;
  const opportunities = task?.opportunities ?? "?";
  if (score.scorer === "review") {
    const severe = score.score.unsupportedSevereFindingCount ?? 0;
    return `${score.score.caught.length}/${opportunities}${severe > 0 ? `+${severe}` : ""}${stale}`;
  }
  return `${score.score.caught.length}/${opportunities}${score.score.trapsAsserted.length > 0 ? "t" : ""}${stale}`;
}

function amount(value: BenchmarkAccounting["estimatedUsd"], format: (value: number) => string): string {
  if (value.kind === "observed") return format(value.value);
  return value.atLeast === undefined ? "unavailable" : `>= ${format(value.atLeast)}`;
}

function providers(entries: readonly Entry[]): string {
  const names = [...new Set(entries.flatMap(({ cell }) => cell.accounting.providers.kind === "observed" ? cell.accounting.providers.value : []))].sort(byCodeUnit);
  const unattributed = entries.some(({ cell }) => cell.accounting.providers.kind === "unavailable");
  return [...names, ...unattributed ? ["unattributed"] : []].join(", ") || "none";
}

/** Quality and false measures of `judge` over the scored cells of one setting, as plain shares of every cell. */
function judgeMeasures(entries: readonly Entry[], tasks: ReadonlyMap<string, RankingTask>, mode: BenchmarkMode, judge: RecordJudge, version: string) {
  let caught = 0;
  let opportunities = 0;
  let falseCount = 0;
  let scored = 0;
  for (const entry of entries) {
    const score = scoreOf(entry, judge, version);
    const known = tasks.get(entry.cell.task)?.opportunities;
    if (!score || score.scorer === "trap") continue;
    scored++;
    if (known !== undefined) {
      caught += score.score.caught.length;
      opportunities += known;
    }
    falseCount += score.scorer === "review" ? score.score.unsupportedSevereFindingCount ?? 0 : Number(score.score.trapsAsserted.length > 0);
  }
  if (scored === 0) return { quality: "n/a", false: "n/a" };
  return {
    quality: opportunities === 0 ? "n/a" : (100 * caught / opportunities).toFixed(1),
    false: mode === "reviewer" ? (falseCount / scored).toFixed(2) : (100 * falseCount / scored).toFixed(1),
  };
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function table(header: readonly string[], align: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${header.join(" | ")} |`, `|${align.join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)];
}

/** One persona's results page. */
function renderResultsPage(persona: string, input: RankingInput): string {
  const campaigns = input.campaigns.filter(({ header }) => header.persona === persona).sort((a, b) => byCodeUnit(a.header.stamp, b.header.stamp));
  // SAFETY: the caller renders only personas that have a campaign.
  const { mode } = campaigns[0]!.header;
  // SAFETY: every persona with records has a corpus in the ranking input.
  const corpus = input.corpora.get(persona)!;
  const role = input.roleOf(persona);
  const version = input.scoringVersion(mode);
  const narrowSuite = corpus.outsideSuite.length > 0;
  const catalogTasks = new Map([...corpus.tasks, ...corpus.outsideSuite].map((task) => [task.id, task]));
  const entries: Entry[] = campaigns.flatMap((campaign) => [...campaign.cells].sort((a, b) => a.repeat - b.repeat).map((cell) => ({ campaign, cell })));
  const failures = campaigns.flatMap((campaign) => campaign.failures.map((failure) => ({ campaign, failure })));
  const settings = [...new Set([...entries.map(({ cell }) => cell.variant), ...failures.map(({ failure }) => failure.variant)])].sort(byCodeUnit);
  const taskIds = [...new Set([...catalogTasks.keys(), ...entries.map(({ cell }) => cell.task)])].sort(byCodeUnit);
  const judges = personaJudges(campaigns, corpus, version);
  const rule = RULE[mode];

  const out: string[] = [
    `# ${persona} benchmark results`,
    "",
    `This page is generated from the record files in \`bench/ab-persona/records/${persona}/\` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with \`${REGENERATE}\`. Findings documents interpret these results and link this page.`,
    "",
    `Role: ${role ?? "none"}. Mode: ${mode}. Corpus: ${catalogTasks.size} tasks${narrowSuite ? `, of which ${corpus.tasks.length} are the ranking suite` : ""}. Records: ${count(campaigns.length, "campaign")}, ${count(entries.length, "cell")}, ${count(failures.length, "failed attempt")}.`,
    "",
    "## Ranking",
    "",
    `The ranking pools every current, scored cell of the role ${role ?? persona}, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).`,
    "",
  ];
  const rankings = role === undefined ? [] : judges.length === 0
    ? rankBenchmarkRecords({ ...input, roles: [role] })
    : judges.flatMap((judge) => rankBenchmarkRecords({ ...input, roles: [role], judge }));
  for (const ranking of rankings) out.push(`### ${ranking.judge ? `Judged by ${judgeLabel(ranking.judge)}` : "No judge"}`, "", ...renderRoleRanking(ranking));

  const legend = mode === "implement"
    ? "P: every hidden test passed. F(p/t): p of t hidden tests passed. T: the cell hit its time limit, a failed attempt."
    : mode === "reviewer"
    ? "c/d: the review caught c of d seeded defects. +n: n unsupported P1/P2 findings. ?: no score by this judge under the current scoring version."
    : "c/f: the answer stated c of f key facts. t: the answer asserted a trap. ?: no score by this judge under the current scoring version.";
  out.push(
    "## Cells by task and setting",
    "",
    `Each cell lists every recorded repeat, oldest campaign first. ${legend} -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it${mode === "implement" ? "; it shows the latest grade that the records hold" : ""}.${narrowSuite ? " (suite) marks a task of the ranking suite." : ""}`,
    "",
  );
  const matrixJudges: readonly (RecordJudge | undefined)[] = mode === "implement" ? [undefined] : judges;
  if (matrixJudges.length === 0) out.push("No judge has scored a current cell of this persona.", "");
  for (const judge of matrixJudges) {
    if (judge) out.push(`### Scored by ${judgeLabel(judge)}`, "");
    const rows = taskIds.map((id) => {
      const task = catalogTasks.get(id);
      const label = `${id}${task === undefined ? " (not in the catalog)" : narrowSuite && corpus.tasks.includes(task) ? " (suite)" : ""}`;
      return [label, ...settings.map((setting) => entries.filter(({ cell }) => cell.task === id && cell.variant === setting).map((entry) => cellToken(entry, task, corpus, mode, judge, version)).join(" ") || "-")];
    });
    out.push(...table(["Task", ...settings], ["---", ...settings.map(() => "---")], rows), "");
  }

  const measureHeaders = mode === "implement" ? ["Full passes", "Timed out"] : judges.flatMap((judge) => [`${rule.quality} (${judgeLabel(judge)})`, `${rule.false} (${judgeLabel(judge)})`]);
  const totals = settings.map((setting) => {
    const own = entries.filter(({ cell }) => cell.variant === setting);
    const combined = combineBenchmarkAccounting(own.map(({ cell }) => cell.accounting));
    const partlyUnpriced = own.filter(({ cell }) => cell.accounting.estimatedUsd.kind === "unavailable").length;
    const measures = mode === "implement"
      ? [String(own.filter((entry) => { const grade = implementationGrade(entry, catalogTasks.get(entry.cell.task)); return grade !== undefined && grade.passed === grade.total; }).length), String(own.filter(({ cell }) => cell.output.kind === "timed-out").length)]
      : judges.flatMap((judge) => { const measured = judgeMeasures(own, catalogTasks, mode, judge, version); return [measured.quality, measured.false]; });
    return [
      setting,
      String(own.length),
      ...measures,
      String(failures.filter(({ failure }) => failure.variant === setting).length),
      `${amount(combined.estimatedUsd, (value) => `$${value.toFixed(3)}`)}${partlyUnpriced > 0 ? ` (${count(partlyUnpriced, "cell")} partly unpriced)` : ""}`,
      amount(combined.tokens, (value) => String(Math.round(value))),
      own.length === 0 ? "n/a" : `${(median(own.map(({ cell }) => cell.durationMs)) / 1000).toFixed(0)}s`,
      providers(own),
    ];
  });
  out.push(
    "## Totals by setting",
    "",
    `Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result.${mode === "implement" ? " A full pass reads the grade that the matrix shows." : ` The ${rule.quality} share counts every scored cell; the ranking instead weighs each corpus the same.`}`,
    "",
    ...table(["Setting", "Cells", ...measureHeaders, "Failed attempts", "Estimated USD", "Tokens", "Median latency", "Providers"], ["---", "---:", ...measureHeaders.map(() => "---:"), "---:", "---:", "---:", "---:", "---"], totals),
    "",
  );

  const scorableSuite = corpus.tasks.filter(({ opportunities }) => opportunities !== undefined);
  const gaps = settings.flatMap((setting) => {
    const missing = scorableSuite.filter((task) => !entries.some(({ campaign, cell }) => cell.variant === setting && cell.task === task.id && staleTask(cell, campaign, corpus) === undefined));
    return missing.length === 0 ? [] : [`- ${setting}: ${missing.map(({ id }) => id).join(", ")}`];
  });
  const retry = new Map<string, { label: string; attempts: number; reasons: Set<string> }>();
  for (const { campaign, failure } of failures) {
    if (campaign.cells.some((cell) => sameSeat(cell, failure))) continue;
    const label = `${failure.variant} ${failure.task} #${failure.repeat} (${campaign.header.stamp})`;
    const prior = retry.get(label) ?? { label, attempts: 0, reasons: new Set<string>() };
    prior.attempts++;
    prior.reasons.add(failure.reason.replace(/\s+/g, " ").trim());
    retry.set(label, prior);
  }
  out.push(
    "## Coverage",
    "",
    "Suite tasks that a setting has no current cell of:",
    "",
    ...gaps.length > 0 ? gaps : ["- None: every setting has a current cell of every suite task."],
    "",
    "Cells to retry (every attempt failed with no result; a resume runs them again):",
    "",
    ...retry.size > 0
      ? [...retry.values()].sort((a, b) => byCodeUnit(a.label, b.label)).map(({ label, attempts, reasons }) => `- ${label}, ${count(attempts, "failed attempt")}: ${[...reasons].sort(byCodeUnit).join("; ")}`)
      : ["- None."],
    "",
    "The ranking above lists each record that it does not pool, with the reason.",
    "",
    "## Campaigns",
    "",
    ...table(["Campaign", "Settings", "Judge", "Cells", "Scores", "Grades", "Failed attempts", "Sources"], ["---", "---", "---", "---:", "---:", "---:", "---:", "---"], campaigns.map((campaign) => {
      const sources = [...new Set(campaign.cells.map(({ sourceIdentity }) => sourceIdentity === undefined ? "not recorded" : sourceIdentity.slice(0, 12)))].sort(byCodeUnit);
      return [
        campaign.header.stamp,
        [...new Set(campaign.cells.map(({ variant }) => variant))].sort(byCodeUnit).join(", "),
        judgeLabel(campaign.header.judge),
        String(campaign.cells.length), String(campaign.scores.length), String(campaign.grades.length), String(campaign.failures.length),
        sources.join(", "),
      ];
    })),
    "",
  );
  return out.join("\n");
}
