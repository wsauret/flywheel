/** The public distribution repository: the publisher trust root (ARCH-DISTRIBUTION-007).
 *
 *  Every release-side script reads the repository identity and the release it
 *  serves as `latest` from here, so the version gate, the perf-gate baseline,
 *  and the publication all answer to one repository. `PUBLIC_REPO` in the
 *  environment overrides the official repository, which changes the trust
 *  root, and the release builds compile in the same repository as the one
 *  their updates come from (`releaseRepository` in `release-contract.ts`).
 *
 *  Reads go over plain HTTPS, the boundary ARCH-DISTRIBUTION-007 declares, so a host needs
 *  no GitHub CLI and no sign-in to gate a candidate against the published
 *  baseline. A token in `GITHUB_TOKEN` or `GH_TOKEN` is sent when present,
 *  which only raises the rate limit; publication still authenticates through
 *  the CLI, because it writes.
 */

import { releaseRepository } from "./release-contract.js";

export const PUBLIC_REPO = releaseRepository(process.env);

const USER_AGENT = "flywheel-release";

interface RequestHeaders {
  readonly [name: string]: string;
}

function headers(accept?: string): RequestHeaders {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    "User-Agent": USER_AGENT,
    ...(accept === undefined ? {} : { Accept: accept }),
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  };
}

/** The tag the public repository serves as `latest`, or undefined when it
 *  proves it serves none. A read that merely failed (network, rate limit,
 *  auth) throws instead of passing for an empty repository, because a false
 *  "no release" would let a gate skip its baseline or a publish miscompute
 *  the next version. */
export async function latestReleaseTag(fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<string | undefined> {
  const response = await fetchImpl(`https://api.github.com/repos/${PUBLIC_REPO}/releases/latest`, {
    headers: headers("application/vnd.github+json"),
  });
  // GitHub answers 404 when it serves no latest release, a draft and a
  // prerelease being no release. Only a proven 404 means "no release".
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`the latest release of ${PUBLIC_REPO} could not be read: HTTP ${response.status} ${response.statusText}`);
  const body: unknown = await response.json();
  const tag = typeof body === "object" && body !== null && "tag_name" in body ? body.tag_name : undefined;
  if (typeof tag !== "string" || tag === "") throw new Error(`the latest release of ${PUBLIC_REPO} states no tag`);
  return tag;
}

/** GitHub's largest page of a release listing. */
const RELEASES_PER_PAGE = 100;

/** The tag of every release `repository` has published, drafts left out, in
 *  the order GitHub lists them. A read that failed throws, because a listing
 *  read short would let the release gate skip a client it still serves. */
export async function publishedReleaseTags(repository: string = PUBLIC_REPO, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<readonly string[]> {
  const tags: string[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`, {
      headers: headers("application/vnd.github+json"),
    });
    if (!response.ok) throw new Error(`the releases of ${repository} could not be listed: HTTP ${response.status} ${response.statusText}`);
    const listed: unknown = await response.json();
    if (!Array.isArray(listed)) throw new Error(`the releases of ${repository} are not listed as an array`);
    for (const release of listed) {
      if (typeof release !== "object" || release === null || !("tag_name" in release) || typeof release.tag_name !== "string" || !("draft" in release)) {
        throw new Error(`the releases of ${repository} list an entry with no tag and draft state`);
      }
      if (release.draft !== true) tags.push(release.tag_name);
    }
    if (listed.length < RELEASES_PER_PAGE) return tags;
  }
}

/** Downloads one published asset of `tag` to `destination`, through the
 *  immutable per-version URL the release manifest also uses. */
export async function downloadReleaseAsset(tag: string, asset: string, destination: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<void> {
  const url = `https://github.com/${PUBLIC_REPO}/releases/download/${tag}/${asset}`;
  const response = await fetchImpl(url, { headers: headers() });
  if (!response.ok || response.body === null) throw new Error(`${url} could not be downloaded: HTTP ${response.status} ${response.statusText}`);
  // Pumped by hand: `Bun.write(path, response)` never finishes a body this
  // size on Windows, while the same stream reads through in seconds.
  const sink = Bun.file(destination).writer();
  for await (const chunk of response.body) sink.write(chunk);
  await sink.end();
}
