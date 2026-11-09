/** One look at the published release metadata.
 *
 *  This is the only place Flywheel asks the network what it could run. The
 *  answer is a candidate release, the statement that this build is already
 *  current, or a reason why nothing could be learned. Nothing here installs,
 *  publishes, or coordinates: a check that answers nothing is an ordinary
 *  outcome, not a failure the user hears about (PI-UPDATES-018).
 *
 *  The manifest URL is the release channel's mutable pointer, which is what
 *  makes "what is newest" answerable at all. The request follows every
 *  redirect that stays on HTTPS, and it reads the whole manifest, however
 *  large a later release makes it. The one bound is a stall bound taken from
 *  the injected scheduler: a request that delivers nothing for that long is
 *  abandoned, and one that keeps delivering always finishes. Each answer of
 *  the redirect chain and each byte of the body is delivery. */

import { errorMessage } from "../../infra/error-message.js";
import { fetchOverHttps, selectReleaseAsset, type RepositoryIdentity, type SelectedRelease } from "../../infra/update/release-manifest.js";
import { isLaterRelease, parseReleaseVersion, type ReleaseVersion } from "../../infra/update/version-order.js";

/** How long release metadata may deliver nothing, neither an answer nor a
 *  byte, before the check is abandoned. A check nobody asked for must not
 *  hold a connection that stopped, but a slow one that still delivers always
 *  finishes. */
export const UPDATE_METADATA_STALL_MS = 10_000;

/** The one clock and timer source every update operation uses: the metadata
 *  bound below, the service's recurring background checks, and its lease renewal.
 *  Injected so those durations are exercised without sleeping. */
export interface UpdateScheduler {
  /** Monotonic enough for durations and lease arithmetic; epoch milliseconds. */
  nowMs(): number;
  /** Runs `fire` after `delayMs`. The returned function cancels it and is
   *  idempotent. */
  setTimer(fire: () => void, delayMs: number): () => void;
}

export const systemUpdateScheduler: UpdateScheduler = {
  nowMs: () => Date.now(),
  setTimer: (fire, delayMs) => {
    const timer = setTimeout(fire, delayMs);
    // Update work never keeps a process alive by itself.
    timer.unref();
    return () => { clearTimeout(timer); };
  },
};

export type UpdateCheckResult =
  /** A newer release exists, with the asset this platform would install. */
  | { readonly kind: "candidate"; readonly release: SelectedRelease }
  /** The published release is this build's version or one it orders as older. */
  | { readonly kind: "current" }
  /** Nothing could be learned. The reason is for the log, never for the user. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface UpdateCheckRequest {
  readonly repository: RepositoryIdentity;
  /** The archive this platform installs (`platformAssetName`). */
  readonly assetName: string;
  readonly currentVersion: ReleaseVersion;
  readonly fetch: typeof globalThis.fetch;
  readonly scheduler: UpdateScheduler;
  /** The caller's cancellation. Aborting reports `unavailable`; the caller
   *  owns the distinction, because only it knows it cancelled. */
  readonly signal?: AbortSignal;
  readonly stallMs?: number;
  /** One named release to read instead of the channel's latest, such as the
   *  release a remote machine runs, which a terminal that reaches it installs
   *  (PI-REMOTE-016). Its manifest must state that release. */
  readonly release?: string;
}

/** The channel's latest manifest, or the manifest of one named release. A
 *  release is published under the tag `v<version>`. */
export function releaseManifestUrl(repository: RepositoryIdentity, release?: string): string {
  const base = `https://github.com/${repository.owner}/${repository.repo}/releases`;
  return release === undefined ? `${base}/latest/download/release.json` : `${base}/download/v${encodeURIComponent(release)}/release.json`;
}

export async function checkForUpdate(request: UpdateCheckRequest): Promise<UpdateCheckResult> {
  const stallMs = request.stallMs ?? UPDATE_METADATA_STALL_MS;
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  request.signal?.addEventListener("abort", abort, { once: true });
  let stalled = false;
  const armStall = (): (() => void) => request.scheduler.setTimer(() => {
    stalled = true;
    controller.abort();
  }, stallMs);
  let cancelStall = armStall();
  const progressed = (): void => {
    cancelStall();
    cancelStall = armStall();
  };

  try {
    const response = await fetchOverHttps(request.fetch, releaseManifestUrl(request.repository, request.release), controller.signal, { onHop: progressed });
    if (!response.ok) return { kind: "unavailable", reason: `the release metadata request answered ${response.status}` };
    const release = selectReleaseAsset(await readText(response, progressed), { assetName: request.assetName });
    if (request.release !== undefined && release.version.canonical !== parseReleaseVersion(request.release)?.canonical) {
      return { kind: "unavailable", reason: `the manifest of release ${request.release} states release ${release.version.canonical}` };
    }
    if (!isLaterRelease(release.version, request.currentVersion)) return { kind: "current" };
    return { kind: "candidate", release };
  } catch (error) {
    if (stalled) return { kind: "unavailable", reason: `the release metadata delivered nothing for ${stallMs}ms` };
    return { kind: "unavailable", reason: errorMessage(error) };
  } finally {
    cancelStall();
    request.signal?.removeEventListener("abort", abort);
  }
}

/** The response body as text, with every chunk reported as progress. */
async function readText(response: Response, progressed: () => void): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    progressed();
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
