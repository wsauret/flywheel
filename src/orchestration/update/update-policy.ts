/** The account's durable update policy, as every caller of the update service
 *  reaches it (ARCH-DISTRIBUTION-022).
 *
 *  This is the one reader of `updates.auto_install`. The service admits an
 *  install through it and the install engine asks it again from inside its own
 *  ownership window, because a second reader of one setting is a second
 *  setting: the two disagree exactly when the file holds something one of them
 *  repairs and the other refuses.
 *
 *  It answers three facts rather than one boolean, because one boolean cannot
 *  say "on, but held off for this run". A toggle writes `persisted`, every
 *  admission decision obeys `effective`, and `forcedOff` is what explains the
 *  difference to the user instead of leaving a settings row that reports
 *  success and changes nothing.
 *
 *  A read that fails or does not validate answers off in every field.
 *  Auto-install is the one policy that replaces a binary without asking, so an
 *  unreadable policy is never an install permission. */

import { Schema } from "effect";
import { persistedSettingDefinition } from "../config/setting-definitions.js";
import { Log } from "../../infra/log.js";
import { findConfigFile } from "../../infra/paths.js";
import { applyEnvOverrides } from "../config/env.js";
import { loadConfig } from "../config/loader.js";
import type { ConfigReadResult } from "../config/config-file.js";
import { createRuntimeConfigOwner, type RuntimeConfigOwner } from "../config/runtime-config-owner.js";
import { ConfigStaleWriteError, patchDefinedSetting, updateConfigTextAwaited } from "../config/writer.js";
import type { UpdateAutoInstall } from "../../protocol/update-protocol-types.js";
import type { UpdatePolicyStore } from "./update-service.js";

export interface DisposableUpdatePolicyStore extends UpdatePolicyStore {
  /** Release the config owner a revalidation created, if one did. */
  dispose(): Promise<void>;
}

const log = Log.create({ service: "update-policy" });

/** The one variable that holds auto-install off for a single run. */
const DISABLE_OVERRIDE = "FLYWHEEL_DISABLE_AUTOUPDATE";

const OFF: UpdateAutoInstall = { persisted: false, forcedOff: false, effective: false };
const AUTO_INSTALL_DEFINITION = persistedSettingDefinition("autoInstall");
if (AUTO_INSTALL_DEFINITION === undefined) throw new Error("Missing auto-install setting definition");

/** Composes the store. Composition reads nothing: the watcher-free config
 *  owner that the lock-backed revalidation runs through is created on the
 *  first revalidation, which only an activation makes, so a store that only
 *  answers display reads and writes never reads the file to build one. */
export function createUpdatePolicyStore(userDataRoot: string): DisposableUpdatePolicyStore {
  let owner: RuntimeConfigOwner | undefined;
  let disposed = false;
  return {
    read: () => readAutoInstall(userDataRoot),
    revalidate: async (decide) => {
      if (disposed) throw new Error("Update policy store is disposed");
      owner ??= await createRuntimeConfigOwner({ userDataRoot, watch: false });
      return await owner.revalidateUseTime(decodeAutoInstall, decide);
    },
    write: async (expected, value) => await updateConfigTextAwaited((source) => {
      if (decodePersistedAutoInstall(source) !== expected) throw new ConfigStaleWriteError();
      return patchDefinedSetting(source, AUTO_INSTALL_DEFINITION, value);
    }, { userDataRoot }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await owner?.dispose();
    },
  };
}

function readAutoInstall(userDataRoot: string): UpdateAutoInstall {
  const configPath = findConfigFile(userDataRoot);
  try {
    // Whether an override holds this run off is a fact about the process, not
    // a difference between two reads, so it is answered even when the durable
    // setting is already off. That is what lets a settings row explain itself
    // in both directions instead of reporting a write nothing obeyed.
    const forcedOff = overrideHoldsOff();
    if (!forcedOff) {
      const persisted = loadConfig(configPath).config.updates.auto_install;
      return { persisted, forcedOff, effective: persisted };
    }
    // The loader's own answer is already held off, so the file's value - the
    // one a toggle writes - is read through the same loader with the override
    // withheld rather than by a second decoder.
    const { [DISABLE_OVERRIDE]: _held, ...withoutOverride } = process.env;
    const persisted = loadConfig(configPath, withoutOverride).config.updates.auto_install;
    return { persisted, forcedOff, effective: false };
  } catch {
    log.warn("update policy unreadable; automatic installation stays off", { code: "update-policy-unreadable" });
    return OFF;
  }
}

function decodeAutoInstall(read: ConfigReadResult): UpdateAutoInstall {
  if (read.kind !== "failure") {
    try {
      const persisted = decodePersistedAutoInstall(read.kind === "text" ? read.text : "");
      const forcedOff = overrideHoldsOff();
      return { persisted, forcedOff, effective: persisted && !forcedOff };
    } catch {
      // An invalid policy answers off below, the same as an unreadable file.
    }
  }
  log.warn("update policy unreadable; automatic installation stays off", { code: "update-policy-unreadable" });
  return OFF;
}

function decodePersistedAutoInstall(source: string): boolean {
  const parsed: unknown = source.length === 0 ? {} : Bun.TOML.parse(source);
  if (!isRecord(parsed)) throw new Error("Config root must be a table");
  const updates = parsed.updates;
  if (updates !== undefined && !isRecord(updates)) throw new Error("updates must be a table");
  return updates?.auto_install === undefined ? true : Schema.decodeUnknownSync(Schema.Boolean)(updates.auto_install);
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether the environment is holding auto-install off for this run, decided
 *  by the one parser that owns the variable rather than by reading it again. */
function overrideHoldsOff(): boolean {
  const raw = process.env[DISABLE_OVERRIDE];
  if (raw === undefined || raw === "") return false;
  return applyEnvOverrides({ [DISABLE_OVERRIDE]: raw }).overrides.updates?.auto_install === false;
}
