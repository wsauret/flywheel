// oxlint-disable flywheel/no-record, typescript/consistent-indexed-object-style -- vendored upstream source keeps its own style; see UPSTREAM.md
import type {
  Context,
  ESTree,
  Location,
  Plugin,
  Rule,
  RuleMeta,
  SourceCode,
  VisitorWithHooks,
} from '@oxlint/plugins';
import { answerAll, type AnswersResult } from './answers.ts';
import { backendFor } from './backend.ts';
import { defaultCacheDir } from './cache.ts';
import { changedLines, changedMode, overlaps, type ChangedLines } from './changed.ts';
import {
  locates,
  locationAsk,
  locationCandidates,
  locationOfLine,
  probabilityOf,
  selectedLocation,
  truncateSnippet,
  verdictAsk,
  type Ask,
} from './jev.ts';
import {
  checkOptions,
  checkPluginOptions,
  DEFAULTS,
  REPORT_LOC,
  SCHEMA,
  snippetNodeFor,
  TARGET_NODE_TYPES,
} from './options.ts';
import type {
  Backend,
  JevPlugin,
  JevPluginOptions,
  JevRule,
  JevRulesPlugin,
  Match,
  ResolvedOptions,
} from './types.ts';

export type {
  CiBehavior,
  JevOptions,
  JevPlugin,
  JevPluginOptions,
  JevRule,
  JevRulesPlugin,
  Target,
} from './types.ts';

const optionsByRaw = new WeakMap<object, ResolvedOptions>();
const warnedReasons = new Set<string>();

function warnOnce(reason: string, message: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  console.warn(`oxlint-plugin-jev: ${message}`);
}

const snippetOf = (sourceCode: SourceCode, node: ESTree.Node): string =>
  node.type === 'Program' ? sourceCode.text : sourceCode.getText(node);

function optionsFor(raw: unknown): ResolvedOptions {
  if (typeof raw !== 'object' || raw === null) return checkOptions(raw);
  const cached = optionsByRaw.get(raw);
  if (cached !== undefined) return cached;
  const options = checkOptions(raw);
  optionsByRaw.set(raw, options);
  return options;
}

function rulesByNodeType(rules: readonly JevRule[]): Map<string, JevRule[]> {
  const byType = new Map<string, JevRule[]>();
  for (const rule of rules) {
    for (const type of TARGET_NODE_TYPES[rule.target]) {
      byType.set(type, [...(byType.get(type) ?? []), rule]);
    }
  }
  return byType;
}

const byTypeByRules = new WeakMap<readonly JevRule[], Map<string, JevRule[]>>();

function nodeTypeIndex(rules: readonly JevRule[]): Map<string, JevRule[]> {
  const cached = byTypeByRules.get(rules);
  if (cached !== undefined) return cached;
  const byType = rulesByNodeType(rules);
  byTypeByRules.set(rules, byType);
  return byType;
}

/** An oxlint rule that collects matches for its group and reports its own. */
interface Member {
  options(context: Context): ResolvedOptions;
  rules(options: ResolvedOptions): readonly JevRule[];
}

interface MatchAsks {
  readonly match: Match;
  readonly verdict: Ask;
  readonly location?: Ask;
}

interface Pass {
  readonly filename: string;
  readonly options: ResolvedOptions;
  readonly backend: Backend;
  readonly backendId: string;
  readonly changed: ChangedLines | null;
  readonly matches: Match[];
  dropped: number;
  outcome: AnswersResult | null;
  asks: MatchAsks[];
  deadline: number;
  refinementFailed: boolean;
  failureRaised: boolean;
}

/**
 * Rules in one group share one request per file. Oxlint merges every enabled rule's visitor into a
 * single AST walk and runs `Program:exit` handlers only after the whole walk, so the first
 * `Program:exit` of a file sees every member's matches and asks once for all of them. `after`
 * hooks run once the walk is over, even when a rule throws, which is where the pass is cleared.
 */
interface Group {
  /** Names the group in warnings. A shared `jev/ask` group is named by its rule id. */
  readonly name?: string;
  pass: Pass | null | 'skip';
  filename: string;
}

function degrade(context: Context, options: ResolvedOptions, reason: string): void {
  if (process.env.CI && options.ci === 'fail') {
    throw new Error(`oxlint-plugin-jev: ${reason} (${context.filename})`);
  }
  warnOnce(reason, `${reason} (${context.filename})`);
}

function startPass(context: Context, member: Member): Pass | 'skip' {
  const options = member.options(context);
  const chosen = backendFor(options);
  // No credential means the developer did not opt in to paid checks. That is not a failed check,
  // so it skips also under CI with `ci: 'fail'`, which governs failed requests only.
  if (!chosen.ok) {
    warnOnce(`missing-key:${chosen.reason}`, `${chosen.reason}, skipping Jev checks`);
    return 'skip';
  }
  let changed: ChangedLines | null = null;
  const mode = changedMode(options);
  if (mode.on) {
    changed = changedLines(context.filename, mode.base, (message) =>
      warnOnce(`changed:${message}`, message),
    );
    if (changed !== 'all' && changed.size === 0) return 'skip';
  }
  return {
    filename: context.filename,
    options,
    backend: chosen.backend,
    backendId: chosen.id,
    changed,
    matches: [],
    dropped: 0,
    outcome: null,
    asks: [],
    deadline: 0,
    refinementFailed: false,
    failureRaised: false,
  };
}

function runBatch(pass: Pass, name: string, filename: string): AnswersResult {
  const { options } = pass;
  if (pass.dropped > 0) {
    const total = pass.matches.length + pass.dropped;
    warnOnce(
      `capped:${name}:${filename}`,
      `${total} matches exceeded maxMatchesPerFile=${options.maxMatchesPerFile}, ${pass.dropped} not checked by ${name} (${filename})`,
    );
  }
  pass.deadline = Date.now() + options.timeoutMs;
  pass.asks = pass.matches.map((match) => ({
    match,
    verdict: verdictAsk(pass.backendId, match),
    location: locates(match) ? locationAsk(pass.backendId, match) : undefined,
  }));
  return answerAll({
    asks: pass.asks.flatMap(({ verdict, location }) =>
      location === undefined ? [verdict] : [verdict, location],
    ),
    backend: pass.backend,
    deadline: pass.deadline,
    cacheDir: defaultCacheDir(),
    onCacheError: (message) => warnOnce('cache-write', message),
  });
}

interface LocatedResult {
  loc: Location;
  failure?: string;
}

function locateMatch(
  pass: Pass,
  match: Match,
  ask: Ask | undefined,
  answers: Map<string, { answer: unknown }>,
): LocatedResult {
  if (ask === undefined || !locates(match)) return { loc: match.loc };
  const { cutoff } = match.rule.location;
  let candidates = locationCandidates(match.snippet);
  let location = selectedLocation(answers.get(ask.key)?.answer, candidates, cutoff);
  while (location && location.start !== location.end) {
    const followup = locationAsk(pass.backendId, match, location);
    candidates = locationCandidates(match.snippet, location);
    const refined = answerAll({
      asks: [followup],
      backend: pass.backend,
      deadline: pass.deadline,
      cacheDir: defaultCacheDir(),
      onCacheError: (message) => warnOnce('cache-write', message),
    });
    if (!refined.ok) return { loc: match.loc, failure: refined.reason };
    location = selectedLocation(refined.answers.get(followup.key)?.answer, candidates, cutoff);
  }
  return { loc: location ? locationOfLine(match.snippet, location.start) : match.loc };
}

function reportMatches(context: Context, member: Member, pass: Pass, outcome: AnswersResult): void {
  if (!outcome.ok) return;
  let failure: { id: string; loc: Location; reason: string } | null = null;
  for (const { match, verdict, location } of pass.asks) {
    if (match.owner !== member) continue;
    const answered = outcome.answers.get(verdict.key);
    const score = probabilityOf(answered?.answer);
    if (answered === undefined || score === null || score < match.rule.cutoff) continue;
    const { id, cutoff, question, message } = match.rule;
    // Avoid further requests after a failed refinement while preserving every confirmed finding.
    const located: LocatedResult = pass.refinementFailed
      ? { loc: match.loc }
      : locateMatch(pass, match, location, outcome.answers);
    if (located.failure !== undefined) {
      pass.refinementFailed = true;
      failure = { id, loc: match.loc, reason: located.failure };
    }
    context.report({
      loc: located.loc,
      messageId: message === undefined ? 'yes' : 'custom',
      data: {
        id,
        model: answered.model,
        score: score.toFixed(2),
        cutoff: cutoff.toFixed(2),
        question,
        message,
      },
    });
  }
  if (failure === null) return;
  // Throwing here would discard findings already reported for this file, so fail mode
  // emits the inference error as a separate diagnostic; skip mode warns as usual.
  if (process.env.CI && pass.options.ci === 'fail') {
    context.report({
      loc: failure.loc,
      messageId: 'unlocated',
      data: { id: failure.id, reason: failure.reason },
    });
  } else {
    warnOnce(failure.reason, `${failure.reason} (${context.filename})`);
  }
}

function visitorsFor(
  group: Group,
  member: Member,
  context: Context,
  nodeTypes: readonly string[],
): VisitorWithHooks {
  const activePass = (): Pass | null =>
    typeof group.pass === 'object' && group.pass?.filename === context.filename ? group.pass : null;

  const collect = (type: string, node: ESTree.Node): void => {
    const pass = activePass();
    if (pass === null) return;
    const rules = nodeTypeIndex(member.rules(pass.options)).get(type);
    if (rules === undefined) return;
    for (const rule of rules) {
      if (
        pass.changed !== null &&
        rule.target !== 'file' &&
        !overlaps(pass.changed, node.loc.start.line, node.loc.end.line)
      ) {
        continue;
      }
      if (pass.matches.length >= pass.options.maxMatchesPerFile) {
        pass.dropped += 1;
        continue;
      }
      const own = snippetOf(context.sourceCode, node);
      const named = snippetNodeFor(node);
      const text = named === node ? own : context.sourceCode.getText(named);
      pass.matches.push({
        rule,
        owner: member,
        loc: REPORT_LOC[rule.target](node, own),
        snippet: truncateSnippet(text, pass.options.maxSnippetChars),
        truncated: text.length > pass.options.maxSnippetChars,
      });
    }
  };

  const visitors: VisitorWithHooks = {};
  for (const type of nodeTypes) visitors[type] = (node) => collect(type, node);

  // `Program` carries the per-file setup as well as the `file` target. The first member to enter
  // a file starts the group's pass; the others join it.
  visitors.Program = (node) => {
    if (group.pass === null || group.filename !== context.filename) {
      group.filename = context.filename;
      group.pass = null;
      group.pass = startPass(context, member);
    }
    collect('Program', node);
  };

  visitors['Program:exit'] = () => {
    const pass = activePass();
    if (pass === null) return;
    pass.outcome ??= runBatch(pass, group.name ?? context.id, context.filename);
    const outcome = pass.outcome;
    if (!outcome.ok) {
      if (pass.failureRaised) return;
      pass.failureRaised = true;
      degrade(context, pass.options, outcome.reason);
      return;
    }
    reportMatches(context, member, pass, outcome);
  };

  visitors.after = () => {
    group.pass = null;
  };
  return visitors;
}

const messages = {
  yes: '[{{id}}] {{model}} answered yes ({{score}} >= {{cutoff}}): {{question}}',
  custom: '[{{id}}] {{message}} ({{model}} answered yes, {{score}} >= {{cutoff}})',
  unlocated:
    'oxlint-plugin-jev: {{reason}} while refining the location of [{{id}}]; the finding is reported at the file level',
};

const ALL_NODE_TYPES = Object.values(TARGET_NODE_TYPES)
  .flat()
  .filter((type) => type !== 'Program');

const meta = {
  type: 'problem',
  docs: {
    description:
      "Ask a decision model (TypeSafe Jev or OpenAI Decisions) a plain-English yes/no question about matched code and report when the yes-probability clears the rule's cutoff.",
  },
  schema: [SCHEMA],
  defaultOptions: [DEFAULTS],
  messages,
} satisfies RuleMeta;

// Each listed rule is its own group, so `jev/ask` and `jev/suggest` keep separate requests and
// budgets, as their option lists are configured independently.
function listRule() {
  const group: Group = { pass: null, filename: '' };
  const member: Member = {
    options: (context) => optionsFor(context.options[0]),
    rules: (options) => options.rules,
  };
  return {
    meta,
    createOnce: (context: Context) => visitorsFor(group, member, context, ALL_NODE_TYPES),
  };
}

// `suggest` is `ask` under a second name, because a JS plugin cannot choose a report's severity:
// oxlint takes it from the rule's config entry, so a warn-level rule list needs its own rule.
const plugin: JevPlugin = {
  meta: { name: 'jev' },
  rules: { ask: listRule(), suggest: listRule() },
} satisfies Plugin;

export default plugin;

/**
 * Builds an oxlint plugin with one rule per question, named `<name>/<id>`, so each question's
 * severity and on/off state live in the oxlint config. All of the plugin's enabled rules share one
 * request per file.
 */
export function createJevPlugin(options: JevPluginOptions): JevRulesPlugin {
  const { name, ...resolved } = checkPluginOptions(options);
  const group: Group = { name, pass: null, filename: '' };
  const rules: Record<string, Rule> = {};
  for (const rule of resolved.rules) {
    const own = [rule];
    const member: Member = { options: () => resolved, rules: () => own };
    const nodeTypes = TARGET_NODE_TYPES[rule.target].filter((type) => type !== 'Program');
    rules[rule.id] = {
      meta: {
        type: 'problem',
        docs: { description: rule.question },
        schema: [],
        messages,
      } satisfies RuleMeta,
      createOnce: (context: Context) => visitorsFor(group, member, context, nodeTypes),
    };
  }
  return { meta: { name }, rules } satisfies Plugin;
}
