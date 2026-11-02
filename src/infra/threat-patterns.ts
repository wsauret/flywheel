/** Shared threat-pattern library for context-window security scanning.
 *  Single source of truth for the
 *  prompt-injection / promptware / exfiltration patterns used by content that
 *  is written into durable prompt-visible stores (memory entries, managed
 *  skills).
 *
 *  Patterns are organized by attack class. Each carries a scope:
 *
 *  - `"all"`: applied everywhere (classic prompt injection, exfiltration).
 *  - `"context"`: adds promptware / C2 / role-play patterns for context files,
 *    memory entries, and tool results.
 *  - `"strict"`: adds persistence / backdoor / exfil-URL patterns for
 *    user-mediated writes (memory tool, skill saves), where a false positive
 *    can be resolved interactively.
 *
 *  Pattern anchoring: patterns anchor on attack-specific vocabulary or
 *  unambiguous attack behavior, never on bossy English. "You must" alone is
 *  everywhere in legitimate instruction files (AGENTS.md), so it is not a
 *  signal. Bounded `(?:\w+\s+){0,8}` filler between key tokens defeats
 *  insert-a-few-words obfuscation without unbounded backtracking. */

/** Hard cap on scanned text. The scanners are advisory guards, not archival
 *  search; bounding input keeps worst-case runtime predictable while keeping
 *  detections near the start of injected content. */
const MAX_SCAN_CHARS = 65_536;

export type ThreatScope = "all" | "context" | "strict";

const FILLER = String.raw`(?:\w+\s+){0,8}`;
type ThreatScopeSets = { readonly [Scope in ThreatScope]: ReadonlySet<ThreatScope> };
type CompiledThreatPatterns = { readonly [Scope in ThreatScope]: ReadonlyArray<readonly [RegExp, string]> };

const PATTERNS: ReadonlyArray<readonly [string, string, ThreatScope]> = [
  // Classic prompt injection (applies everywhere).
  [String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`, "prompt_injection", "all"],
  [String.raw`system\s+prompt\s+override`, "sys_prompt_override", "all"],
  [String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`, "disregard_rules", "all"],
  [String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don't\s+have)\s+${FILLER}(restrictions|limits|rules)`, "bypass_restrictions", "all"],
  [String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, "html_comment_injection", "all"],
  [String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, "hidden_div", "all"],
  [String.raw`translate\s+[^\n]{0,512}\s+into\s+[^\n]{0,512}\s+and\s+(execute|run|eval)`, "translate_execute", "all"],
  [String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "deception_hide", "all"],

  // Role-play / identity hijack: common in scraped web content and poisoned
  // context files, too noisy for arbitrary text.
  [String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`, "role_hijack", "context"],
  [String.raw`pretend\s+${FILLER}(you\s+are|to\s+be)\s+`, "role_pretend", "context"],
  [String.raw`output\s+${FILLER}(system|initial)\s+prompt`, "leak_system_prompt", "context"],
  [String.raw`(respond|answer|reply)\s+without\s+${FILLER}(restrictions|limitations|filters|safety)`, "remove_filters", "context"],
  [String.raw`you\s+have\s+been\s+${FILLER}(updated|upgraded|patched)\s+to`, "fake_update", "context"],
  // Identity override via spec instead of jailbreak; verb pair anchored so
  // "name your variables" does not match.
  [String.raw`\bname\s+yourself\s+\w+`, "identity_override", "context"],

  // C2 / promptware. Anchored on C2-specific vocabulary; "register as a node"
  // alone appears in distributed-systems docs, so blocking is reserved for
  // user-mediated writes where the user can intervene.
  [String.raw`register\s+(as\s+)?a?\s*node`, "c2_node_registration", "context"],
  [String.raw`(heartbeat|beacon|check[\s-]?in)\s+(to|with)\s+`, "c2_heartbeat", "context"],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, "c2_task_pull", "context"],
  [String.raw`connect\s+to\s+the\s+network\b`, "c2_network_connect", "context"],
  // Verb-anchored so the broader "you must X" stays legal.
  [String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, "forced_action", "context"],
  // Anti-forensic instructions are near-zero false positive in legit content.
  [String.raw`only\s+use\s+one[\s-]?liners?\b`, "anti_forensic_oneliner", "context"],
  [String.raw`never\s+${FILLER}(?:create|write)\s+${FILLER}(?:script|file)\s+${FILLER}disk`, "anti_forensic_disk", "context"],
  // Unsetting agent-runtime environment variables is pure attack behavior.
  [String.raw`unset\s+\w*(?:CLAUDE|CODEX|FLYWHEEL|AGENT|OPENAI|ANTHROPIC)\w*`, "env_var_unset_agent", "context"],

  // Known C2 / red-team framework brands. Every token must be a distinctive
  // offensive-security brand; a common English word here false-positives
  // legitimate instruction files.
  [String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, "known_c2_framework", "context"],
  [String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, "c2_explicit", "context"],
  [String.raw`\bcommand\s+and\s+control\b`, "c2_explicit_long", "context"],

  // Exfiltration via curl/wget/cat with secrets (applies everywhere).
  [String.raw`curl\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, "exfil_curl", "all"],
  [String.raw`wget\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, "exfil_wget", "all"],
  [String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, "read_secrets", "all"],
  [String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`, "send_to_url", "strict"],
  [String.raw`(include|output|print|share)\s+${FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, "context_exfil", "strict"],

  // Persistence / backdoor (strict scope: memory and skill writes).
  [String.raw`authorized_keys`, "ssh_backdoor", "strict"],
  [String.raw`\$HOME/\.ssh|~/\.ssh`, "ssh_access", "strict"],
  [String.raw`(\$HOME|~)/\.flywheel/auth`, "flywheel_auth_access", "strict"],
  [String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, "agent_config_mod", "strict"],
  [String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}\.flywheel/flywheel\.toml`, "flywheel_config_mod", "strict"],

  // Hardcoded secrets.
  [String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`, "hardcoded_secret", "strict"],
];

/** Invisible and bidirectional unicode used in injection attacks. Directional
 *  isolates and invisible math operators are real attack tools. */
const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  "​", "‌", "‍", "⁠", "⁢", "⁣", "⁤", "﻿",
  "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩",
]);

function compile(scope: ThreatScope): ReadonlyArray<readonly [RegExp, string]> {
  // "all" applies everywhere; "context" implies the strict scanners want it too.
  const admitted: ThreatScopeSets = {
    all: new Set(["all"]),
    context: new Set(["all", "context"]),
    strict: new Set(["all", "context", "strict"]),
  };
  return PATTERNS
    .filter((entry) => admitted[scope].has(entry[2]))
    .map(([pattern, id]) => [new RegExp(pattern, "i"), id] as const);
}

const COMPILED: CompiledThreatPatterns = {
  all: compile("all"),
  context: compile("context"),
  strict: compile("strict"),
};

/** Matched pattern ids in `content` at the given scope, plus
 *  `invisible_unicode_U+XXXX` findings for invisible codepoints. The invisible
 *  check runs on raw content before NFKC folding, because normalization can
 *  strip the very codepoints it looks for; the regex pass runs on NFKC-folded
 *  text so full-width homographs cannot bypass keyword checks. */
export function scanForThreats(content: string, scope: ThreatScope = "context"): string[] {
  if (!content) return [];
  const bounded = content.slice(0, MAX_SCAN_CHARS);

  const findings: string[] = [];
  for (const char of new Set(bounded)) {
    if (INVISIBLE_CHARS.has(char)) {
      findings.push(`invisible_unicode_U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }

  const normalized = bounded.normalize("NFKC");
  for (const [pattern, id] of COMPILED[scope]) {
    if (pattern.test(normalized)) findings.push(id);
  }
  return findings;
}

/** Human-readable error for the first threat found, or null. For paths that
 *  block on the first hit and only need a yes/no plus a message. */
export function firstThreatMessage(content: string, scope: ThreatScope = "strict"): string | null {
  const [first] = scanForThreats(content, scope);
  if (!first) return null;
  if (first.startsWith("invisible_unicode_")) {
    return `Blocked: content contains invisible unicode character ${first.replace("invisible_unicode_", "")} (possible injection).`;
  }
  return `Blocked: content matches threat pattern '${first}'. Content is injected into the system prompt and must not contain injection or exfiltration payloads.`;
}
