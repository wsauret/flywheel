import type { ConfigFileLocation, ConfigReadResult } from "./config-file.js";
import { normalizePersistentProcessPermission } from "./loader.js";
import { createRuntimeConfigOwner, type RuntimeConfigOwner } from "./runtime-config-owner.js";

type UnknownObject = { [K in string]: unknown };

export interface PersistentProcessPolicyOptions extends ConfigFileLocation {
  /** Immutable command-line authorization for this CLI host lifetime. */
  readonly forcedByCli: boolean;
  readonly owner?: RuntimeConfigOwner;
}

export interface PersistentProcessPolicy {
  readonly persisted: boolean;
  readonly forcedByCli: boolean;
  readonly effective: boolean;
}

/** Read persistent-process intent under config ownership and combine it with the immutable CLI override.
 * Invalid, unparseable, or refused external intent fails closed. The result applies to future admission only. */
export async function persistentProcessPolicy(options: PersistentProcessPolicyOptions): Promise<PersistentProcessPolicy> {
  const owner = options.owner ?? await createRuntimeConfigOwner({ ...options, watch: false });
  return await owner.revalidateUseTime(decodePersistentProcessPermission, (persisted) => ({
    persisted,
    forcedByCli: options.forcedByCli,
    effective: persisted || options.forcedByCli,
  }));
}

function decodePersistentProcessPermission(read: ConfigReadResult): boolean {
  if (read.kind !== "text") return false;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(read.text);
  } catch {
    return false;
  }
  const raw = isRecord(parsed) ? parsed : {};
  normalizePersistentProcessPermission(raw, []);
  return raw.allow_persistent_processes === true;
}

function isRecord(value: unknown): value is UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
