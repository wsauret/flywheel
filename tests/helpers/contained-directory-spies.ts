import { tmpdir } from "node:os";
import type { ContainedDirectory } from "../../src/infra/platform/files/descriptor-directory/descriptor-directory-contract.js";
import { openContainedDirectory } from "../../src/infra/platform/files/descriptor-directory.js";

/** The prototype that every directory the selected backend opens shares, so a
 *  spy on one of its methods sees that call on every held directory. */
export function heldDirectoryPrototype(): ContainedDirectory {
  const probe = openContainedDirectory(tmpdir(), []);
  try {
    return Object.getPrototypeOf(probe);
  } finally {
    probe.close();
  }
}
