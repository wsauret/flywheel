import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDirectories } from "../../../helpers/directories.js";
import { fakeModelInfos } from "../../../helpers/model-tier-fixtures.js";
import type { AttemptRow } from "../../../../src/workflows/view/types.js";

export async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-config-models-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Isolated account data root (ARCH-DIRECTORIES-002) every account-global path in these
 *  tests derives from: the global config, credentials, models.dev snapshot. */
export const USER_DATA_ROOT = testDirectories(process.cwd()).userDataRoot;

export const tierOptions = { userDataRoot: USER_DATA_ROOT, modelInfos: fakeModelInfos };

/** A credential directory that never exists, so a case that reads the
 *  account's credentials reads none. The shared test account home is not
 *  empty for certain: another test file in the same process can leave a
 *  credential in its default profile, and these cases pass no key resolver. */
export const NO_CREDENTIALS = "/scratch/no-credentials";

export function step(overrides: Partial<AttemptRow>): AttemptRow {
  return {
    id: "runtime-plan",
    definitionId: "plan",
    briefId: "plan",
    workflowDefinitionId: "workflow",
    name: "Plan",
    status: "pending",
    writes: [],
    resumeRevertCount: 0,
    ...overrides,
  };
}
