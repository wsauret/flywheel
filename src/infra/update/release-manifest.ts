/** The external release contract as an installed client reads it:
 *  `release.json`, the repository identity it is published under, and the
 *  URLs a download may follow.
 *
 *  An installed client refuses only what a correct release can never fail
 *  (ARCH-DISTRIBUTION-008). It reads the fields it acts on - the version, and the name,
 *  URL, size, and digest of its own asset - and ignores every other field
 *  and every other asset, so a later release can add, change, or drop
 *  anything else. What the client does depend on, such as its asset being
 *  named `flywheel-<target>.tar.gz`, is a release contract that
 *  `scripts/release-acceptance.ts` holds before a tag exists, together with
 *  every rule of every client still served.
 *
 *  The configured GitHub repository plus normal HTTPS is the publisher trust
 *  root. The manifest comes from that repository over HTTPS, and it binds the
 *  asset to its size and SHA-256 digest, so the asset URL itself needs no
 *  rule beyond HTTPS: the digest proves the bytes whichever host serves
 *  them. */

import { Schema } from "effect";
import { errorMessage } from "../error-message.js";
import { parseReleaseVersion, type ReleaseVersion } from "./version-order.js";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The manifest, the repository it names, or a URL it publishes does not
 *  state what this client needs to act on. */
export class ReleaseManifestError extends Schema.TaggedErrorClass<ReleaseManifestError>()("ReleaseManifest", {
  message: Schema.String,
  reason: Schema.String,
}) {}

function refuse(reason: string): never {
  throw new ReleaseManifestError({ message: `The release manifest is not usable: ${reason}`, reason });
}

export interface RepositoryIdentity {
  readonly owner: string;
  readonly repo: string;
}

interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  /** The size the release states, which is the release's own bound on the
   *  download. */
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SelectedRelease {
  readonly version: ReleaseVersion;
  readonly asset: ReleaseAsset;
}

/** Only the two fields a client acts on are decoded, so any other field, and
 *  any other asset of any shape, is the release's to add or change. */
const ManifestSchema = Schema.Struct({
  version: Schema.String,
  assets: Schema.Array(Schema.Unknown),
});
const decodeManifest = Schema.decodeUnknownSync(ManifestSchema);

const AssetSchema = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sha256: Schema.String,
});
const decodeAsset = Schema.decodeUnknownSync(AssetSchema);

/** The archive one build target installs. A running build passes its own
 *  target (`buildPlatformArch`), so it updates to the kind of build it is.
 *  Which targets a release publishes is the release's decision. */
export function platformAssetName(platformArch: string): string {
  return `flywheel-${platformArch}.tar.gz`;
}

/** Exactly one GitHub owner and repository. This is the trust root, so it is
 *  parsed once from the configured value and never re-derived from a URL. */
export function parseRepositoryIdentity(value: string): RepositoryIdentity {
  const [owner, repo, ...rest] = value.split("/");
  if (owner === undefined || repo === undefined || rest.length > 0) refuse(`a repository is exactly one owner and one name, not ${JSON.stringify(value)}`);
  if (!OWNER.test(owner)) refuse(`the repository owner ${JSON.stringify(owner)} is not a GitHub owner name`);
  if (!REPO.test(repo) || repo === "." || repo === "..") refuse(`the repository name ${JSON.stringify(repo)} is not a GitHub repository name`);
  return { owner, repo };
}

/** Decode one manifest and return the asset this platform installs.
 *
 *  Throws `ReleaseManifestError` when the text is not JSON, states no
 *  version and asset list, states a version that cannot be a directory name,
 *  publishes no asset named `assetName`, or states that asset without an
 *  HTTPS URL, a whole positive size, or a SHA-256 digest. Each of these
 *  leaves the client with nothing it could verify. */
export function selectReleaseAsset(rawManifest: string, options: { readonly assetName: string }): SelectedRelease {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch (error) {
    refuse(`the manifest is not JSON: ${errorMessage(error)}`);
  }

  let manifest: typeof ManifestSchema.Type;
  try {
    manifest = decodeManifest(parsed);
  } catch (error) {
    refuse(`the manifest states no version and asset list: ${errorMessage(error)}`);
  }

  const version = parseReleaseVersion(manifest.version);
  if (!version) refuse(`the manifest version ${JSON.stringify(manifest.version)} cannot name a build directory`);

  const listed = manifest.assets.find((candidate) => typeof candidate === "object" && candidate !== null && "name" in candidate && candidate.name === options.assetName);
  if (listed === undefined) refuse(`the release publishes no ${options.assetName}`);
  let asset: typeof AssetSchema.Type;
  try {
    asset = decodeAsset(listed);
  } catch (error) {
    refuse(`the ${options.assetName} of that release states no URL, size, and digest: ${errorMessage(error)}`);
  }
  const sha256 = asset.sha256.toLowerCase();
  if (!SHA256_HEX.test(sha256)) refuse(`the ${options.assetName} of that release states the digest ${JSON.stringify(asset.sha256)}, which is not a SHA-256`);
  assertHttpsUrl(asset.url);
  return { version, asset: { name: asset.name, url: asset.url, sizeBytes: asset.size, sha256 } };
}

/** Admit one release URL, a redirect target included, before it is
 *  followed. HTTPS is the one rule: TLS is the transport's trust, and the
 *  digest is the payload's. */
function assertHttpsUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    refuse("a release URL is not a URL");
  }
  if (url.protocol !== "https:") refuse(`${quotedUrl(url)} does not use HTTPS`);
}

/** A URL as a refusal and a log may state it: its origin and path. User
 *  information and the query are left out, because a manifest URL can carry
 *  a credential and a signed redirect target carries a signature. */
function quotedUrl(url: string | URL): string {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return JSON.stringify(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
  } catch {
    return "a URL that does not parse";
  }
}

/** The one call a release request makes of `fetch`, so a caller can hand
 *  `globalThis.fetch` or a fake of exactly this call. */
type ReleaseFetch = (url: string, init: { readonly signal: AbortSignal; readonly redirect: "manual"; readonly headers?: { readonly [name: string]: string } }) => Promise<Response>;

/** The most redirects one release request follows: the Fetch standard's own
 *  limit, which every browser and `fetch` applies. A URL that needs more
 *  answers no standard client, so the limit never refuses a release that any
 *  person can download. */
const MAX_REDIRECTS = 20;

export interface ReleaseRequestOptions {
  /** Sent to every hop, so a `range` reaches the host that serves the bytes. */
  readonly headers?: { readonly [name: string]: string };
  /** Told each URL as it answers, a redirect included. A caller that bounds
   *  a stall counts an answer as progress, and the last URL told is the one
   *  that served the response. */
  readonly onHop?: (url: string) => void;
}

/** The response of a release request, following every redirect that stays
 *  on HTTPS. The client follows redirects itself rather than through
 *  `fetch`, because a hop to plain HTTP would let anyone on the path answer
 *  in the publisher's place. The first URL is the caller's: the release
 *  channel's own, or an asset URL `selectReleaseAsset` admitted. A redirect
 *  that names no target, a hop off HTTPS, and a chain past the Fetch
 *  standard's limit are refused with a `ReleaseManifestError`. Any other
 *  status is the caller's to read. */
export async function fetchOverHttps(fetchImpl: ReleaseFetch, url: string, signal: AbortSignal, options: ReleaseRequestOptions = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current, { signal, redirect: "manual", ...(options.headers === undefined ? {} : { headers: options.headers }) });
    options.onHop?.(current);
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => {});
    if (hop === MAX_REDIRECTS) refuse(`${quotedUrl(url)} redirected more than the ${MAX_REDIRECTS} times the Fetch standard allows`);
    const location = response.headers.get("location");
    if (!location) refuse(`${quotedUrl(current)} answered ${response.status} and named no redirect target`);
    current = new URL(location, current).toString();
    assertHttpsUrl(current);
  }
}
