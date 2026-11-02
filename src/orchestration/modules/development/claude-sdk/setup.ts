import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { AuthProfileStore } from "../../../../infra/auth/auth-profile-store.js";
import type { ExternalAccount } from "../../../../infra/llm/access-provider.js";
import { updateModelAssignments } from "../../../config/writer.js";
import { AGENT_ROLE_IDS, DEFAULT_ROLES } from "../../../config/roles.js";

/** The one auth profile the setup writes. Flywheel stores no credential in it, and the provider's Claude accounts are
 *  its only candidates, so failover cannot leave them. */
export const CLAUDE_SDK_PROFILE = "claude-sdk";

export interface ClaudeSdkProfileOptions {
  readonly userDataRoot: string;
  /** The Claude accounts that the Agent SDK provider finds for an auth profile's directory. */
  readonly accounts: (authDirectory: string) => readonly ExternalAccount[];
}

export interface ClaudeSdkSetupOptions extends ClaudeSdkProfileOptions {
  readonly model?: string;
}

/** What a setup leaves: the profile's auth directory, and the Claude accounts that the profile has. A new profile has
 *  none until a login of its own (`setup --login`, or the login button in that profile). */
export interface ClaudeSdkSetupResult {
  readonly authDirectory: string;
  readonly accounts: readonly ExternalAccount[];
}

/** What a Flywheel data directory holds before a setup writes to it: nothing yet (it is missing or empty), only a
 *  home that a whole-home setup prepared for the bridge, or an account that a person uses. */
type SetupHome = "new" | "bridge" | "account";

/** The store a setup writes through, and what the data directory held before the setup. */
interface OpenedSetup {
  readonly store: AuthProfileStore;
  readonly home: SetupHome;
}

function openSetup(options: ClaudeSdkProfileOptions): OpenedSetup {
  const store = new AuthProfileStore(options.userDataRoot);
  const profiles = store.inspect().profiles.map(({ id }) => id);
  // Any data at all is a home that a person used: its sessions, logs, or caches need no settings file or auth store.
  const home = profiles.length === 0
    ? !existsSync(options.userDataRoot) || readdirSync(options.userDataRoot).length === 0 ? "new" : "account"
    : profiles.length === 1 && profiles[0] === CLAUDE_SDK_PROFILE ? "bridge" : "account";
  return { store, home };
}

/**
 * Adds the `claude-sdk` auth profile to an account. It writes nothing else: the settings, the module selection, the
 * active profile, and every other profile stay as they are, so it can prepare an account that a person already
 * uses. It never reads a token. Running it again changes nothing. It refuses a data directory that holds no
 * account, so a mistyped home creates nothing.
 */
export async function setupClaudeSdkProfile(options: ClaudeSdkProfileOptions): Promise<ClaudeSdkSetupResult> {
  const { store, home } = openSetup(options);
  if (home === "new") throw new Error(`${dirname(options.userDataRoot)} holds no Flywheel account, so there is no account to add the ${CLAUDE_SDK_PROFILE} profile to. Check --home, or run the setup without --profile-only to prepare a new home.`);
  return await addClaudeSdkProfile(store, options);
}

async function addClaudeSdkProfile(store: AuthProfileStore, options: ClaudeSdkProfileOptions): Promise<ClaudeSdkSetupResult> {
  const profile = await store.open(CLAUDE_SDK_PROFILE) ?? await store.create(CLAUDE_SDK_PROFILE, "Agent SDK");
  const authDirectory = profile.authDirectory;
  profile.close();
  return { authDirectory, accounts: options.accounts(authDirectory) };
}

/**
 * Prepares one Flywheel home for the Agent SDK provider alone: it adds the `claude-sdk` profile
 * (setupClaudeSdkProfile) and makes it the active profile. Roles follow their central policy unless the caller
 * supplies a model setting. The active profile belongs to the whole home, so this refuses an existing account.
 */
export async function setupClaudeSdkHome(options: ClaudeSdkSetupOptions): Promise<ClaudeSdkSetupResult> {
  const { store, home } = openSetup(options);
  if (home === "account") throw new Error(`${dirname(options.userDataRoot)} already holds a Flywheel account, and this setup would change the active profile for all of it. Run it with --profile-only to add only the ${CLAUDE_SDK_PROFILE} profile.`);
  // The account home may be new; Flywheel creates its own data directory inside it.
  mkdirSync(dirname(options.userDataRoot), { recursive: true });
  // The profile comes first, so a setup that stops part way leaves a home that a second run accepts.
  const result = await addClaudeSdkProfile(store, options);
  await store.writeStickyProfile(CLAUDE_SDK_PROFILE);
  if (options.model !== undefined) {
    const model = options.model;
    const roles = new Set<string>([...Object.keys(DEFAULT_ROLES), ...AGENT_ROLE_IDS]);
    updateModelAssignments({
      mutations: [...roles].map((roleId) => ({ slot: { kind: "role", roleId }, patch: { model } })),
    }, { userDataRoot: options.userDataRoot, authProfileId: () => CLAUDE_SDK_PROFILE });
  }
  return result;
}
