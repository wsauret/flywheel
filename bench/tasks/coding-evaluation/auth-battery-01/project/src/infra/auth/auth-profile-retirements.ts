import type { ContainedDirectory } from "../descriptor-directory.js";
import { requireAuthProfileName } from "../paths.js";

export const AUTH_PROFILE_RETIREMENTS_FILE = ".profile-retirements.json";
const MAX_RETIREMENTS_BYTES = 1024 * 1024;

interface AuthProfileSuccessors {
  [id: string]: string;
}

/** Immutable one-hop successors for retired stable profile ids. */
export type AuthProfileRetirements = Readonly<AuthProfileSuccessors>;

/** The ledger is authoritative. An unreadable ledger must never mean no transfers. */
export class AuthProfileRetirementsError extends Error {
  readonly _tag = "AuthProfileRetirementsError" as const;
  constructor(readonly path: string, cause: unknown) {
    super(`Cannot read auth profile transfers at ${path}. Repair the file or restore it from backup before changing profiles.`, { cause });
  }
}

/** Missing files predate profile retirement. All present files must use the current strict format. */
export function readAuthProfileRetirements(auth: ContainedDirectory): AuthProfileRetirements {
  try {
    const bytes = auth.readFile(AUTH_PROFILE_RETIREMENTS_FILE, MAX_RETIREMENTS_BYTES);
    if (bytes === undefined) return Object.freeze(Object.create(null));
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Object.keys(value).length !== 2 || !("version" in value) || value.version !== 1 || !("successors" in value)) throw new Error("unsupported ledger format");
    const successors = value.successors;
    if (typeof successors !== "object" || successors === null || Array.isArray(successors)) throw new Error("invalid successors");
    const canonical: AuthProfileSuccessors = Object.create(null);
    for (const [id, successor] of Object.entries(successors)) {
      requireAuthProfileName(id);
      if (typeof successor !== "string") throw new Error("invalid successor");
      requireAuthProfileName(successor);
      if (Object.hasOwn(successors, successor)) throw new Error("successors must be live one-hop ids");
      canonical[id] = successor;
    }
    return Object.freeze(canonical);
  } catch (cause) {
    throw new AuthProfileRetirementsError(`${auth.canonicalPath()}/${AUTH_PROFILE_RETIREMENTS_FILE}`, cause);
  }
}

/** Publish under the profile operation lock. A returned durability error is after publication, never rollback. */
export function retireAuthProfile(auth: ContainedDirectory, id: string, successorId: string): void {
  const previous = readAuthProfileRetirements(auth);
  const successors = Object.fromEntries([
    ...Object.entries(previous).map(([retired, successor]) => [retired, successor === id ? successorId : successor]),
    [id, successorId],
  ]);
  const failure = auth.writeFile(AUTH_PROFILE_RETIREMENTS_FILE, JSON.stringify({ version: 1, successors }));
  if (failure !== undefined) throw failure;
}
