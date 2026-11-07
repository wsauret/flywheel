import { trustedProbeLaunch, trustedProbeRun } from "./process-container.js";

const SID_TIMEOUT_MS = 2_000;
const ACL_TIMEOUT_MS = 2_000;
const SID_PATTERN = /\bS-\d-\d+(?:-\d+)+\b/;


export interface WindowsPrivateDirectoryAclCommandResult {
  readonly success: boolean;
  readonly stdout: string;
}

export interface WindowsPrivateDirectoryAclOperations {
  readonly platform: NodeJS.Platform;
  readonly run: (argv: readonly string[], timeoutMs: number) => WindowsPrivateDirectoryAclCommandResult;
}

export interface WindowsPrivateDirectoryAclAsyncOperations {
  readonly platform: NodeJS.Platform;
  readonly run: (argv: readonly string[], timeoutMs: number) => Promise<WindowsPrivateDirectoryAclCommandResult>;
}

export type WindowsPrivateDirectoryAclPort = (directoryPath: string) => void;
export type WindowsPrivateDirectoryAclAsyncPort = (directoryPath: string) => Promise<void>;

function warnAclFailure(directory: string, error: unknown): void {
  void import("./log.js")
    .then(({ Log }) => { Log.create({ service: "windows-private-directory-acl" }).warn("Windows private directory ACL was not applied", { directory, error }); })
    .catch(() => {});
}


const defaultOperations: WindowsPrivateDirectoryAclOperations = {
  platform: process.platform,
  run(argv, timeoutMs) {
    try {
      const launch = trustedProbeLaunch(argv);
      const result = Bun.spawnSync([...launch.argv], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: timeoutMs,
        env: launch.env,
        windowsHide: launch.windowsHide,
      });
      return { success: result.success, stdout: new TextDecoder().decode(result.stdout) };
    } catch {
      return { success: false, stdout: "" };
    }
  },
};

const defaultAsyncOperations: WindowsPrivateDirectoryAclAsyncOperations = {
  platform: process.platform,
  async run(argv, timeoutMs) {
    const outcome = await trustedProbeRun(argv, timeoutMs);
    return { success: outcome.kind === "output", stdout: outcome.kind === "output" ? outcome.text : "" };
  },
};

/** The one command that makes a directory owner-only.
 *
 *  Both edits travel together on purpose. `/inheritance:r` drops the inherited
 *  entries, so a separate grant leaves a window - and, if the grant fails, a
 *  permanent state - where the directory carries no entry at all and its own
 *  owner can no longer read it. icacls applies both edits in one pass, so the
 *  directory moves straight from inherited access to owner-only access.
 *
 *  The `*` prefix is what marks the argument as a SID. Without it icacls reads
 *  the string as an account name, finds no such account, and fails with "No
 *  mapping between account names and security IDs was done". */
function aclCommand(directoryPath: string, sid: string): readonly string[] {
  return ["icacls", directoryPath, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`];
}

/** Build the sync owner-ACL operation used by existing non-process callers. */
export function createWindowsPrivateDirectoryAclPort(
  overrides: Partial<WindowsPrivateDirectoryAclOperations> = {},
): WindowsPrivateDirectoryAclPort {
  const operations: WindowsPrivateDirectoryAclOperations = { ...defaultOperations, ...overrides };
  let sid: string | undefined;
  return (directoryPath) => {
    if (operations.platform !== "win32") return;
    try {
      if (sid === undefined) {
        const identity = operations.run(["whoami", "/user"], SID_TIMEOUT_MS);
        if (!identity.success) throw new Error("whoami could not resolve the current user SID");
        sid = identity.stdout.match(SID_PATTERN)?.[0];
        if (sid === undefined) throw new Error("whoami returned no user SID");
      }
      const applied = operations.run(aclCommand(directoryPath, sid), ACL_TIMEOUT_MS);
      if (!applied.success) throw new Error("icacls could not replace the directory ACL with an owner-only grant");
    } catch (error) {
      warnAclFailure(directoryPath, error);
    }
  };
}

/** Build the async owner-ACL operation used by persistent spool creation. Concurrent calls share the SID lookup. */
export function createWindowsPrivateDirectoryAclAsyncPort(
  overrides: Partial<WindowsPrivateDirectoryAclAsyncOperations> = {},
): WindowsPrivateDirectoryAclAsyncPort {
  const operations: WindowsPrivateDirectoryAclAsyncOperations = { ...defaultAsyncOperations, ...overrides };
  let sidPromise: Promise<string> | undefined;
  const resolveSid = (): Promise<string> => {
    if (sidPromise) return sidPromise;
    const current = (async () => {
      const identity = await operations.run(["whoami", "/user"], SID_TIMEOUT_MS);
      if (!identity.success) throw new Error("whoami could not resolve the current user SID");
      const sid = identity.stdout.match(SID_PATTERN)?.[0];
      if (sid === undefined) throw new Error("whoami returned no user SID");
      return sid;
    })();
    sidPromise = current;
    void current.catch(() => { if (sidPromise === current) sidPromise = undefined; });
    return current;
  };
  return async (directoryPath) => {
    if (operations.platform !== "win32") return;
    try {
      const sid = await resolveSid();
      const applied = await operations.run(aclCommand(directoryPath, sid), ACL_TIMEOUT_MS);
      if (!applied.success) throw new Error("icacls could not replace the directory ACL with an owner-only grant");
    } catch (error) {
      warnAclFailure(directoryPath, error);
    }
  };
}

/** The principals one icacls listing grants to, lowercased. The first line
 *  carries the directory path before its entry and the rest are indented
 *  continuations. An entry whose shape this reader does not recognize yields no
 *  principals at all, so an unreadable listing is never read as private. */
function aclPrincipals(listing: string, directoryPath: string): readonly string[] {
  const principals: string[] = [];
  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.startsWith(directoryPath) ? raw.slice(directoryPath.length) : raw;
    const entry = line.trim();
    if (entry === "" || /^(Successfully processed|Failed processing)/i.test(entry)) continue;
    const rights = entry.lastIndexOf(":(");
    if (rights === -1) return [];
    principals.push(entry.slice(0, rights).toLowerCase());
  }
  return principals;
}

/** Whether a directory admits its owner and nobody else.
 *
 *  This is the Windows counterpart of a POSIX mode carrying no group or other
 *  bits. Windows keeps no mode bits and reports no owning uid, so the ACL is
 *  the only privacy a caller can prove there. Every answer fails closed: an
 *  unresolved SID, a refused listing, or an entry this reader cannot parse all
 *  report the directory as not private.
 *
 *  An inherited entry is not by itself a leak, so rights are not inspected;
 *  what matters is that no principal other than the owner appears at all. */
export function windowsDirectoryIsOwnerOnly(
  directoryPath: string,
  overrides: Partial<WindowsPrivateDirectoryAclOperations> = {},
): boolean {
  const operations: WindowsPrivateDirectoryAclOperations = { ...defaultOperations, ...overrides };
  if (operations.platform !== "win32") return false;
  const identity = operations.run(["whoami", "/user"], SID_TIMEOUT_MS);
  const account = operations.run(["whoami"], SID_TIMEOUT_MS);
  if (!identity.success || !account.success) return false;
  const owner = new Set(
    [identity.stdout.match(SID_PATTERN)?.[0], account.stdout.trim()]
      .filter((name): name is string => name !== undefined && name !== "")
      .map((name) => name.toLowerCase()),
  );
  if (owner.size === 0) return false;
  const listing = operations.run(["icacls", directoryPath], ACL_TIMEOUT_MS);
  if (!listing.success) return false;
  const principals = aclPrincipals(listing.stdout, directoryPath);
  return principals.length > 0 && principals.every((principal) => owner.has(principal));
}

export const applyWindowsPrivateDirectoryAcl = createWindowsPrivateDirectoryAclPort();
export const applyWindowsPrivateDirectoryAclAsync = createWindowsPrivateDirectoryAclAsyncPort();