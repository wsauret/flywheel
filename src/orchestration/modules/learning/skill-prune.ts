/** Deterministic skill lifecycle pruner. Walks the curator-managed packages
 *  and archives the ones whose latest real activity is older than the
 *  archive window. The guards: pinned skills are exempt (`managed: user`),
 *  archiving is the maximum destructive action and is
 *  recoverable via `skills:restore`, and a never-used skill younger than the
 *  stale window is left alone entirely because absence of evidence is not
 *  evidence of staleness. Activity derives from durable facts
 *  (`tool.input.completed` loads, `skill.written` writes), and `stale` is a
 *  derived report label rather than stored state, so no reactivation
 *  bookkeeping exists. */

import { statSync } from "node:fs";
import { sep } from "node:path";
import type { FactRecorder } from "../../../infra/fact-recorder.js";
import type { ProjectDirectories } from "../../../infra/directory-authorities.js";
import { Log } from "../../../infra/log.js";
import type { SkillWrittenFact } from "../../../workflows/skill-facts.js";
import type { SkillRegistryRevision } from "../../../workflows/skill-schema.js";
import { ownedSkillStoreDirs } from "../../../workflows/skills.js";
import { publishSkillMutation } from "./skill-mutation-publisher.js";
import { planSkillMutation } from "./skill-mutation-plan.js";
import { eligibleLearnedSkills } from "./learned-skill-eligibility.js";

const log = Log.create({ service: "skill-prune" });

const DEFAULT_STALE_AFTER_DAYS = 30;
const DEFAULT_ARCHIVE_AFTER_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SkillPruneInput {
  readonly signal?: AbortSignal;
  activity: ReadonlyMap<string, number>;
  /** Re-read while the package lock is held, immediately before archive. */
  latestActivity: (skillId: string) => number | undefined | Promise<number | undefined>;
  registry: () => SkillRegistryRevision;
  /** Directory authorities the two owned skill stores are selected from. */
  directories: ProjectDirectories;
  /** Test override for wall-clock time. */
  now?: number;
  staleAfterDays?: number;
  /** Zero turns the lifecycle pass off: nothing is walked, archived, or
   *  labelled stale. The pruner owns this reading of the setting so every
   *  caller agrees on what a disabled window means. */
  archiveAfterDays?: number;
  /** Report what would change without archiving anything. */
  dryRun?: boolean;
  /** Records one skill.written fact per archive; a failure is contained. */
  record?: FactRecorder<SkillWrittenFact>["record"];
}

export interface SkillPruneReport {
  checked: number;
  archived: string[];
  /** Inside the stale window but not yet archivable: a derived label. */
  stale: string[];
}


export async function applySkillLifecycleTransitions(input: SkillPruneInput): Promise<SkillPruneReport> {
  input.signal?.throwIfAborted();
  const archiveAfterDays = input.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS;
  if (archiveAfterDays === 0) return { checked: 0, archived: [], stale: [] };
  const now = input.now ?? Date.now();
  const staleCutoff = now - (input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS) * DAY_MS;
  const archiveCutoff = now - archiveAfterDays * DAY_MS;
  const owned = ownedSkillStoreDirs(input.directories);
  const eligible = eligibleLearnedSkills({
    revision: input.registry(),
    projectRoot: owned.project,
    globalRoot: owned.user,
    reach: "project-and-global",
  });

  const report: SkillPruneReport = { checked: 0, archived: [], stale: [] };

  for (const { definition } of eligible) {
    input.signal?.throwIfAborted();
    const dir = definition.source.kind === "filesystem" ? definition.source.canonicalDir : "";

    report.checked += 1;

    const activity = input.activity.get(definition.id);
    // If never active, the package file's own timestamp anchors the clock so
    // a new skill does not immediately archive itself (first-seen seeds to
    // now, and mtime is that seed here).
    const anchor = activity ?? packageMtime(dir, now);

    // Never-used grace floor: a use=0 skill younger
    // than the stale window is left alone entirely.
    const neverUsed = activity === undefined;
    if (neverUsed && anchor > staleCutoff) continue;

    if (anchor <= archiveCutoff) {
      if (input.dryRun) {
        report.archived.push(definition.id);
        continue;
      }
      if (!input.record) {
        log.warn("skill prune archive skipped because no durable fact recorder is available", { skill: definition.id });
        continue;
      }
      const config = { ...input.directories, registry: input.registry };
      const planned = planSkillMutation(config, { kind: "pruner" }, { kind: "archive", name: definition.id });
      if (planned.kind === "refused") {
        log.info("skill prune archive planning refused", { skill: definition.id, error: planned.error });
        continue;
      }
      const publication = await publishSkillMutation({
        config,
        origin: { kind: "pruner" },
        plan: planned.plan,
        writer: { record: input.record },
        guard: async () => (await input.latestActivity(definition.id) ?? 0) <= archiveCutoff,
      });
      if (publication.kind !== "settled") {
        log.info("skill prune archive did not settle", { skill: definition.id, outcome: publication.kind });
        continue;
      }
      report.archived.push(definition.id);
    } else if (anchor <= staleCutoff) {
      report.stale.push(definition.id);
    }
  }

  if (report.archived.length > 0 || report.stale.length > 0) {
    log.info("skill lifecycle transitions applied", {
      checked: report.checked,
      archived: report.archived,
      stale: report.stale,
      dryRun: input.dryRun === true,
    });
  }
  return report;
}

function packageMtime(dir: string, fallback: number): number {
  try {
    return statSync(`${dir}${sep}SKILL.md`).mtimeMs;
  } catch {
    return fallback;
  }
}
