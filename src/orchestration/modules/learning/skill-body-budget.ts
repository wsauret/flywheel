import { parseFrontmatter } from "../../../infra/frontmatter.js";
import { SKILL_BODY_BUDGET_CHARS, SKILL_BODY_HEADROOM_CHARS, SKILL_FILE } from "../../../workflows/skill-schema.js";
import type { SkillMutationPlan, SkillStoreConfig } from "./skill-store-types.js";

/** The `SKILL.md` body a plan produces, or undefined when the plan writes no package. */
function plannedBody(plan: SkillMutationPlan): string | undefined {
  if (plan.outcome.kind !== "package") return undefined;
  const file = plan.outcome.package.files.find((entry) => entry.path === SKILL_FILE);
  if (file === undefined) return undefined;
  const parsed = parseFrontmatter(file.content);
  // Trailing whitespace is bookkeeping, not authored content: the composer adds
  // a closing newline, so measuring it would refuse a body of exactly the
  // budget by one character.
  return (parsed ? parsed.body : file.content).trimEnd();
}

/** The largest headed sections of a body, biggest first, so a refusal can name what is worth demoting. */
function largestSections(body: string, limit = 3): readonly string[] {
  const lines = body.split("\n");
  const heads: { index: number; title: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^#{2,3} /u.test(line)) heads.push({ index, title: line.trim() });
  }
  if (heads.length === 0) return [];
  return heads
    .map((head, position) => {
      const end = heads[position + 1]?.index ?? lines.length;
      const size = lines.slice(head.index, end).reduce((total, line) => total + line.length + 1, 0);
      return { title: head.title, size };
    })
    .sort((left, right) => right.size - left.size)
    .slice(0, limit)
    .map((section) => `  ${section.size.toLocaleString("en-US")}  ${section.title}`);
}

/** Hold one body inside the write-time budget while allowing an over-budget legacy body only to shrink. */
export function refuseOverBudgetBody(config: SkillStoreConfig, plan: SkillMutationPlan): string | undefined {
  const body = plannedBody(plan);
  if (body === undefined) return undefined;
  const after = body.length;
  const installed = config.registry().skills.get(plan.name);
  const before = installed?.body.trimEnd().length;
  if (before !== undefined && before > SKILL_BODY_BUDGET_CHARS) {
    if (after <= before) return undefined;
    return [
      `Skill "${plan.name}": the body is already ${before.toLocaleString("en-US")} characters, over the ${SKILL_BODY_BUDGET_CHARS.toLocaleString("en-US")}-character limit. This write would make it ${after.toLocaleString("en-US")}. While a body is over the limit it may only get smaller, so this write must leave it at ${before.toLocaleString("en-US")} characters or fewer.`,
      `Take it to ${Math.max(0, SKILL_BODY_BUDGET_CHARS - SKILL_BODY_HEADROOM_CHARS).toLocaleString("en-US")} characters or fewer if you can, so this skill stops being refused on every edit.`,
      "Nothing you wrote is lost. Free the space, then send this same write again with your new content still in it.",
      demotionGuidance(body),
    ].join("\n\n");
  }
  if (after <= SKILL_BODY_BUDGET_CHARS) return undefined;
  const over = after - SKILL_BODY_BUDGET_CHARS;
  const target = over + SKILL_BODY_HEADROOM_CHARS;
  return [
    `Skill "${plan.name}": this write would make the body ${after.toLocaleString("en-US")} characters. The limit is ${SKILL_BODY_BUDGET_CHARS.toLocaleString("en-US")}.`,
    `Remove at least ${target.toLocaleString("en-US")} characters from the body: ${over.toLocaleString("en-US")} to reach the limit, plus ${SKILL_BODY_HEADROOM_CHARS.toLocaleString("en-US")} so the next edit to this skill is not refused as well. Stopping exactly at the limit leaves the next writer the same problem you have now.`,
    "Nothing you wrote is lost. Free the space, then send this same save again with your new content still in it.",
    demotionGuidance(body),
  ].join("\n\n");
}

function demotionGuidance(body: string): string {
  const sections = largestSections(body);
  const ranked = sections.length > 0 ? `\nBIGGEST SECTIONS IN THE BODY YOU SENT\n${sections.join("\n")}\n` : "";
  return `KEEP IN THE BODY
  The method: how to do this class of work here.
  Decision rules, ordering constraints, and the failure modes that change what an agent does.
  One line per reference file, naming its full path and when to read it.

FIRST, CHECK WHETHER YOU ARE CORRECTING RATHER THAN ADDING
  Read what the body already claims about the thing you are about to write. If what you learned
  contradicts a claim that is there, fix that claim instead of appending underneath it. Watch for
  words like "always", "never", or "exactly one of": a body that states a rule near the top and then
  lists a case that breaks it further down will send the next reader the wrong way, and the reader
  has no way to tell which of the two is current.
  This is not a way to make room, though it often frees some. Do it whether or not it does.
${ranked}
HOW TO MAKE ROOM. Try in this order and stop when you have freed enough.

1. Move a section into a reference file. Do this first. It is the only move with real capacity.
   What to look for: a general heading with case-specific playbooks stacked under it, each one added
   by a different past session. That is how a body grows without anyone noticing, and those blocks
   are what a reader almost never needs.
   How: call skill_manage save with path "references/<topic>.md" and that section's text as content.
   Then replace the section in the body with one line giving the full path references/<topic>.md and
   when to read it. A reference file is not read unless an agent asks for it by name.
   One file, one topic. If the name needs the word "and", make two files.
   A file under about 1,200 characters costs a whole tool call for almost nothing, so do not make one
   for a single small section. When the body holds several sections of the SAME kind and each is that
   small, put them in one file together instead: a file of same-kind playbooks is still one topic, and
   it keeps the set consistent. Move the whole set or leave the whole set. Splitting a set by size
   leaves a skill whose organisation a reader cannot recognise, which is worse than either extreme.

2. Shorten wording that repeats itself. Only when the text restates its own headings or repeats a
   rule it already stated. On a body that is already dense this returns almost nothing: measured on a
   real skill, a careful pass over the whole file saved 53 characters. Do not spend a turn here first.

3. Remove a section that is no longer needed. Only when the same instruction already appears
   elsewhere in this skill, or an agent could get the same answer by reading the current code, git
   history, or configuration.

NEVER
  Never remove the skill. You are moving one chunk of content out of one file, nothing more.
  Never remove an instruction an agent needs to do the work.
  Never reword or renumber text you move; it keeps its exact wording and its own list numbering.
  You may renumber what is left behind in the body.

CHECK BEFORE YOU SEND
  The body is under ${SKILL_BODY_BUDGET_CHARS.toLocaleString("en-US")} characters.
  Every reference file you created is named in the body with its full references/ path.
  Every references/ path named in the body exists.

In your reply, say which sections you moved and anything you were unsure about.`;
}
