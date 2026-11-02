import type { ProjectDirectories } from "../infra/directory-authorities.js"
import { Log } from "../infra/log.js"
import { inspectSkillLibrary } from "../workflows/skill-health.js"
import { createInstalledDefinitionRegistry } from "./definition-catalog.js"
import type { ModuleHealthReport } from "./module-health.js"

const log = Log.create({ service: "skill-doctor" })

/** One line for a reader who did not ask for the whole report: the skill
 *  library's section of `/doctor`. Builds this project's registry, so a caller
 *  that has directories but no registry can ask without owning one. */
export function summariseSkillHealth(directories: ProjectDirectories): ModuleHealthReport {
  const definitions = createInstalledDefinitionRegistry(directories);
  const findings = inspectSkillLibrary({ revision: definitions.skills(), directories });
  // The summary is one line, so the breakdown behind it goes to the debug log:
  // a health figure a reader cannot reconcile with the report is worse than none.
  log.debug("skill health summarised", {
    projectRoot: directories.projectRoot,
    userDataRoot: directories.userDataRoot,
    skills: definitions.skills().skills.size,
    brokenDetail: findings.filter((finding) => finding.severity === "broken").map((finding) => `${finding.skill}|${finding.kind}|${finding.path ?? finding.target ?? ""}`),
  });
  const broken = findings.filter((finding) => finding.severity === "broken").length;
  const smell = findings.length - broken;
  if (findings.length === 0) return { attention: false, lines: ["Nothing to report."] };
  return { attention: true, lines: [`${broken} broken, ${smell} worth a look. Run \`flywheel skills doctor\` for the report.`] };
}
