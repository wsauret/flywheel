import { createHash } from "node:crypto";
import { MACOS_LAUNCHER_BUNDLE, MACOS_LAUNCHER_EXECUTABLE } from "./native-assets.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ServeLane } from "./cli-subprocess.js";
import { FLYWHEEL_DIR_NAME } from "./directory-authorities.js";
import { ensureDirectoryUnder, type ContainedFileLocation } from "./write-file-under.js";

// Account-global state (shared across projects). Every helper here is a pure
// derivation from the `userDataRoot` the CLI selected once at startup
// (ADR-013): no path is looked up again, so a redirected account home moves
// all of them together.
export const globalConfigFile = (userDataRoot: string): string => path.join(userDataRoot, "flywheel.toml");
export const configurationReferenceFile = (userDataRoot: string): string => path.join(userDataRoot, "configuration.md");
export const accountAuthDir = (userDataRoot: string): string => path.join(userDataRoot, "auth");
/** Account-global slash-command usage log: the single ranking source for the
 *  slash popup, shared by every project. */
export const commandUsageFile = (userDataRoot: string): string => path.join(userDataRoot, "command_usage.jsonl");
/** Account-global event store for facts shared by every project runtime. */
export const accountEventStoreDbFile = (userDataRoot: string): string => path.join(userDataRoot, "account", "flywheel.sqlite");
/** Private rendezvous state for the one serving process of a lane. The
 *  installed lane keeps the directory it always had; the dev lane's sits
 *  beside it, so a dev serve and the installed service never share a
 *  socket, record, start lock, or token. */
const serveDirName = (lane: ServeLane): string => lane === "installed" ? "serve" : "serve-dev";
export const accountServeDir = (userDataRoot: string, lane: ServeLane): string => path.join(userDataRoot, serveDirName(lane));
export const accountServeRecordPath = (userDataRoot: string, lane: ServeLane): string => path.join(accountServeDir(userDataRoot, lane), "serve.json");
export const accountServeTokenPath = (userDataRoot: string, lane: ServeLane): string => path.join(accountServeDir(userDataRoot, lane), "serve.token");
export const accountServeStartLockPath = (userDataRoot: string, lane: ServeLane): string => path.join(accountServeDir(userDataRoot, lane), "serve.start.lock");
/** The installed account service's start record: the last build whose
 *  service listened, and the starts of one build that have not listened
 *  (ADR-014). Only an installed build starts through it, so only the installed
 *  lane has one. */
export const accountServeStartRecordPath = (userDataRoot: string): string => path.join(accountServeDir(userDataRoot, "installed"), "starts.json");
/** The one stable bundle launchd runs the account service through on macOS.
 *  It sits outside the immutable builds because its identity must outlive them. */
export const accountServeLauncherPath = (userDataRoot: string): string => path.join(userDataRoot, "launcher", MACOS_LAUNCHER_BUNDLE);
/** The program inside that bundle, which launchd runs and which runs the service as its child. */
export const accountServeLauncherExecutablePath = (userDataRoot: string): string => path.join(userDataRoot, "launcher", MACOS_LAUNCHER_EXECUTABLE);
/** The file launchd appends the account service's standard error to on
 *  macOS. It sits beside the launcher bundle, whose directory exists whenever
 *  the job can run, so launchd can always open it. Each start keeps it bounded. */
export const accountServeErrorLogPath = (userDataRoot: string): string => path.join(userDataRoot, "launcher", "serve.stderr.log");

/** A lane's account server has one fixed POSIX address. Windows named pipes
 * live in a machine-global namespace, so its address includes the account
 * digest. */
export function accountServeSocketPath(userDataRoot: string, lane: ServeLane, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const digest = createHash("sha256").update(userDataRoot).digest("hex").slice(0, 16);
    return String.raw`\\.\pipe\flywheel-${serveDirName(lane)}-${digest}`;
  }
  return path.join(accountServeDir(userDataRoot, lane), "serve.sock");
}

// eslint-disable-next-line no-control-regex -- boundary: reject terminal control characters in externally supplied profile display names
const AUTH_PROFILE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Display names are user-visible text. They must contain printable content, but
 * unlike profile ids they never reach a filesystem API. */
export function isAuthProfileDisplayName(name: string): boolean {
  return !AUTH_PROFILE_CONTROLS.test(name) && /[^\s]/u.test(name);
}

/** One profile-id contract for path validation and config schema. */
export function isAuthProfileName(name: string): boolean {
  return name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && isAuthProfileDisplayName(name);
}

/** Validate one profile directory component before it reaches a filesystem API. */
export function requireAuthProfileName(name: string): string {
  if (!isAuthProfileName(name)) throw new Error(`invalid auth profile name: ${JSON.stringify(name)}`);
  return name;
}

/** Validate display text before it is persisted or rendered. */
export function requireAuthProfileDisplayName(name: string): string {
  if (!isAuthProfileDisplayName(name)) throw new Error(`invalid auth profile display name: ${JSON.stringify(name)}`);
  return name;
}

export const authDir = (userDataRoot: string, profileName: string): string =>
  path.join(accountAuthDir(userDataRoot), "profiles", requireAuthProfileName(profileName));
/** One account secret file, located for a contained operation. The account data
 *  directory is the trusted base and Flywheel owns it, so it is opened without
 *  following a symlink at its own name; `auth` and the file below it are walked
 *  against their parent's descriptor and refuse a link too. A link planted at any
 *  of the three is therefore refused instead of redirecting a credential read or
 *  write out of the account. */
export const accountSecretFile = (authDirPath: string, name: string): ContainedFileLocation => ({
  baseDir: path.dirname(authDirPath),
  relativePath: `${path.basename(authDirPath)}/${name}`,
});
export const modelsSnapshotFile = (userDataRoot: string): string => path.join(userDataRoot, "models", "models.json");
/** Cross-process availability authority: account-scoped quota state every
 *  Flywheel process reads and commits to. The file name carries the authority
 *  protocol, so binaries speaking different protocols each coordinate on
 *  their own file instead of one failing closed on the other's. The caller
 *  owns the protocol number; this module owns only where the file lives. */
export const availabilityAuthorityDbFile = (userDataRoot: string, protocolVersion: number): string => path.join(userDataRoot, `availability-authority-v${protocolVersion}.sqlite`);
/** Profile-local usage authority. Schema migrations retain this established file. */
export const subscriptionUsageAuthorityDbFile = (profileDir: string): string => path.join(profileDir, "subscription-usage-authority-v2.sqlite");
/** Where an editor runtime for one project listens, and where a client looks
 *  for it. Both sides derive it from the same two values, so the address is a
 *  rendezvous nothing has to publish, discover, or keep in sync.
 *
 *  The name is a digest of the project root rather than the root itself. A unix
 *  socket path is bounded by the platform (104 bytes on macOS) and a project
 *  path is not, so a nested checkout would otherwise fail to bind for a reason
 *  no user could act on. Keeping it account-global rather than a `.flywheel`
 *  entry also keeps a transport artifact out of the user's tree.
 *
 *  This is an address, never a lock. One project's durable state is guarded by
 *  the generation lease in `project-state-lease.ts`, which already admits
 *  concurrent owners; nothing here adds a second claim over the same state. */
const projectDigest = (projectRoot: string): string => createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);

/** Where a project's browser token lives: the installed lane's runtime
 *  directory, keyed by the project digest, owner-only. The token belongs to
 *  the project, not to the lane that serves it: the project's web port is the
 *  same in both lanes, so a browser tab or bookmark opens the project again
 *  after a restart in either lane, and a project that moves between the
 *  installed service and a dev serve keeps its link. */
export function projectWebTokenPath(userDataRoot: string, projectRoot: string): string {
  return path.join(accountServeDir(userDataRoot, "installed"), `${projectDigest(projectRoot)}.web-token`);
}

/** The one fixed loopback port on a machine that lists every project with a
 *  running runtime and opens any of them: the address a person remembers or
 *  is sent to, when the project ports below are the ones they bookmark.
 *  Whichever runtime binds it first serves it; the rest keep trying. The
 *  dev lane's hub sits one port below, outside the project range that
 *  starts one port above. */
export const ACCOUNT_HUB_HOSTNAME = "127.0.0.1";
const ACCOUNT_HUB_PORT = 41_000;
export const accountHubPort = (lane: ServeLane): number => lane === "installed" ? ACCOUNT_HUB_PORT : ACCOUNT_HUB_PORT - 1;
export const accountHubOrigin = (lane: ServeLane): string => `http://${ACCOUNT_HUB_HOSTNAME}:${accountHubPort(lane)}`;

const PROJECT_WEB_PORT_FIRST = ACCOUNT_HUB_PORT + 1;
const PROJECT_WEB_PORT_COUNT = 8_000;

/** The loopback port a project's runtime prefers for its browser serving,
 *  derived from the project digest so it is the same on every start and a
 *  bookmark or a tab left open reaches the project again. The range sits
 *  below the ephemeral ports the OS hands out, so an unrelated program rarely
 *  holds one; a runtime that finds its port taken binds an ephemeral one and
 *  records that in its identity instead. */
export function projectWebPort(projectRoot: string): number {
  return PROJECT_WEB_PORT_FIRST + (Number.parseInt(projectDigest(projectRoot).slice(0, 8), 16) % PROJECT_WEB_PORT_COUNT);
}

/** Account-global binary distribution (ADR-014). Every installed build is one
 *  immutable directory under the versions root, and `current` is the single
 *  activation a launch resolves before it executes anything: a symlink on
 *  macOS and Linux and a pointer file on Windows (`update/active-build.ts`). */
export const versionsDir = (userDataRoot: string): string => path.join(userDataRoot, "versions");
/** The activation's own name, for a caller that resolves it as one entry of
 *  the account root through a held descriptor rather than as a path. */
export const CURRENT_BUILD_LINK = "current";
export const currentBuildLink = (userDataRoot: string): string => path.join(userDataRoot, CURRENT_BUILD_LINK);
/** Where processes register the installed build they are executing, so a
 *  collector can tell a build nothing is reading from one a week-long session
 *  still runs. It sits beside the update authority because it is the same
 *  account-global update coordination, and never inside a build tree, which is
 *  immutable. */
export const liveBuildsDir = (userDataRoot: string): string => path.join(userDataRoot, "update", "live");
/** Cross-process update authority: the account-scoped successful-check
 *  timestamp and fenced update lease every Flywheel process, the manual
 *  update command, and the installer coordinate through. It sits in its own
 *  directory so that directory can be admitted as private without any claim
 *  over the account root, and the file name carries the authority protocol,
 *  so binaries speaking different protocols each coordinate on their own
 *  file. The caller owns the protocol number; this module owns only where
 *  the file lives. */
export const updateAuthorityDbFile = (userDataRoot: string, protocolVersion: number): string => path.join(userDataRoot, "update", `authority-v${protocolVersion}.sqlite`);
/** Shared agent directory: `<account home>/.agents`. Other agent tools
 *  read it too, so it sits beside
 *  `userDataRoot` rather than under it, and it derives from the same
 *  startup-selected account home. */
export const sharedAgentsDir = (accountHome: string): string => path.join(accountHome, ".agents");
/** Account-global AGENTS.md every harness reads. */
export const globalAgentsFile = (accountHome: string): string => path.join(sharedAgentsDir(accountHome), "AGENTS.md");

// Project state, under the project root the caller was given.
export const SESSIONS_DIR = `${FLYWHEEL_DIR_NAME}/sessions`;
export const LOG_DIR = `${FLYWHEEL_DIR_NAME}/log`;
const EVENT_STORE_FILE = `${FLYWHEEL_DIR_NAME}/flywheel.sqlite`;
const PROMPT_HISTORY_FILE = `${FLYWHEEL_DIR_NAME}/prompt_history.json`;

export function resolveComposerHistoryPath(projectRoot: string): string {
  return path.resolve(projectRoot, PROMPT_HISTORY_FILE);
}

export function resolveEventStoreDbFile(projectRoot: string): string {
  return path.resolve(projectRoot, EVENT_STORE_FILE);
}

export function resolveConversationSearchDbFile(projectRoot: string): string {
  return path.resolve(projectRoot, ".flywheel", "conversation-search.sqlite");
}

export function resolveSessionSummaryDbFile(projectRoot: string): string {
  return path.resolve(projectRoot, ".flywheel", "session-summary.sqlite");
}

export function resolveSessionsDir(projectRoot: string): string {
  return path.resolve(projectRoot, SESSIONS_DIR);
}

/**
 * Returns the global config file path when it exists, else undefined so
 * callers fall back to schema defaults. The config is single-source and
 * lives under `userDataRoot`; project-local TOMLs are not consulted.
 */
export function findConfigFile(userDataRoot: string): string | undefined {
  const configPath = globalConfigFile(userDataRoot);
  return fs.existsSync(configPath) ? configPath : undefined;
}

export function toFileUri(filePath: string, cwd = process.cwd()): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  return pathToFileURL(resolved).href;
}

export function isHandoffPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replaceAll("\\", "/");
  return /(^|\/)\.flywheel\/sessions\/[^/]+\/[^/]+\.json$/.test(normalized);
}

/** One session's directory below the project root, and the entries Flywheel owns
 *  inside it. Every one is a relative path a contained walk resolves component by
 *  component, so `sessionId` must be exactly one path component: a session id
 *  that carried a separator, an empty name, a `..`, or a NUL would name a
 *  directory outside the session tree. */
export function requireSessionIdComponent(sessionId: string): string {
  if (sessionId === "" || sessionId === "." || sessionId === ".." || /[/\\]/.test(sessionId) || sessionId.includes("\0")) {
    throw new Error(`a session id must be one path component, not ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

export function sessionRelativeDir(sessionId: string): string {
  return `${SESSIONS_DIR}/${requireSessionIdComponent(sessionId)}`;
}

export function ownerPidRelativePath(sessionId: string): string {
  return `${sessionRelativeDir(sessionId)}/owner.pid`;
}

export function resolveSessionDir(sessionId: string, projectRoot: string): string {
  return path.resolve(projectRoot, sessionRelativeDir(sessionId));
}

/** Create one session directory as a contained tree: every component below the
 *  project root is created relative to its parent's descriptor, so a replaced
 *  `.flywheel`, `sessions`, or session-id component cannot redirect the session
 *  tree out of the project. */
export function ensureSessionDir(sessionId: string, projectRoot: string): void {
  ensureDirectoryUnder(projectRoot, sessionRelativeDir(sessionId));
}

export function resolveOwnerPidPath(sessionId: string, projectRoot: string): string {
  return path.resolve(projectRoot, ownerPidRelativePath(sessionId));
}