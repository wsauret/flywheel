import { cp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { directoryIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { objectValue, stringValue } from "../../src/orchestration/modules/development/benchmark/task-schema.js";

/** Skill packages installed into the sandbox's project store. The baseline installs nothing. */
export interface Arm {
  readonly id: string;
  readonly description: string;
  readonly invokeSkill?: string;
  readonly identity: string | null;
  readonly skillsDir?: string;
}

export const BASELINE_ARM_ID = "baseline";

/** Load an immutable skill treatment. */
export async function loadArm(armsDir: string, id: string): Promise<Arm> {
  if (id === BASELINE_ARM_ID) return { id, description: "The shipped chat agent with no change.", identity: null };
  const dir = join(armsDir, id);
  if (!existsSync(join(dir, "arm.json"))) throw new Error(`Unknown arm ${id}: ${dir}/arm.json does not exist`);
  const config = objectValue(JSON.parse(await readFile(join(dir, "arm.json"), "utf8")), `${id}/arm.json`);
  const invokeSkill = config.invokeSkill === undefined ? undefined : stringValue(config.invokeSkill, `${id}/arm.json.invokeSkill`);
  const skillsDir = join(dir, "skills");
  if (invokeSkill !== undefined && !existsSync(join(skillsDir, invokeSkill, "SKILL.md"))) throw new Error(`Arm ${id} invokes ${invokeSkill}, which skills/ does not hold`);
  return {
    id, description: stringValue(config.description, `${id}/arm.json.description`),
    ...(invokeSkill === undefined ? {} : { invokeSkill }), identity: await directoryIdentity(dir),
    ...(existsSync(skillsDir) ? { skillsDir } : {}),
  };
}

/** Copy a treatment's packages into the sandbox, where they mask bundled packages with the same ids. */
export async function installArm(sandboxDir: string, arm: Arm): Promise<void> {
  if (arm.skillsDir) await cp(arm.skillsDir, join(sandboxDir, ".flywheel", "skills"), { recursive: true });
}
