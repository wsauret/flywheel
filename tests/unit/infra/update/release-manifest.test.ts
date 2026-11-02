import { describe, expect, test } from "bun:test";
import { fetchOverHttps, parseRepositoryIdentity, platformAssetName, ReleaseManifestError, selectReleaseAsset } from "../../../../src/infra/update/release-manifest.js";

const ASSET = "flywheel-darwin-arm64.tar.gz";
const DIGEST = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

function assetUrl(assetName = ASSET, version = "1.2.3"): string {
  return `https://github.com/wsauret/flywheel/releases/download/v${version}/${assetName}`;
}

/** One published manifest, with whatever the case under test changes. */
function manifest(overrides: { [key: string]: unknown } = {}, assetOverrides: { [key: string]: unknown } = {}): string {
  return JSON.stringify({
    version: "1.2.3",
    assets: [
      { name: ASSET, url: assetUrl(), size: 1024, sha256: DIGEST, ...assetOverrides },
      { name: "flywheel-linux-x64.tar.gz", url: assetUrl("flywheel-linux-x64.tar.gz"), size: 2048, sha256: DIGEST },
    ],
    ...overrides,
  });
}

function select(raw: string, assetName = ASSET) {
  return selectReleaseAsset(raw, { assetName });
}

describe("platform asset names", () => {
  test("every published target derives its canonical archive name", () => {
    expect(platformAssetName("darwin-arm64")).toBe("flywheel-darwin-arm64.tar.gz");
    expect(platformAssetName("darwin-x64")).toBe("flywheel-darwin-x64.tar.gz");
    expect(platformAssetName("linux-x64")).toBe("flywheel-linux-x64.tar.gz");
    expect(platformAssetName("linux-arm64")).toBe("flywheel-linux-arm64.tar.gz");
    expect(platformAssetName("linux-x64-musl")).toBe("flywheel-linux-x64-musl.tar.gz");
    expect(platformAssetName("linux-arm64-musl")).toBe("flywheel-linux-arm64-musl.tar.gz");
    expect(platformAssetName("win32-x64")).toBe("flywheel-win32-x64.tar.gz");
    expect(platformAssetName("win32-arm64")).toBe("flywheel-win32-arm64.tar.gz");
  });

  test("a target the client was not told about still derives its name, so the release decides what it publishes", () => {
    expect(platformAssetName("freebsd-x64")).toBe("flywheel-freebsd-x64.tar.gz");
  });
});

describe("repository identity", () => {
  test("exactly one owner and repository is parsed", () => {
    expect(parseRepositoryIdentity("wsauret/flywheel")).toEqual({ owner: "wsauret", repo: "flywheel" });
    expect(parseRepositoryIdentity("Some-Org/fly_wheel.tool")).toEqual({ owner: "Some-Org", repo: "fly_wheel.tool" });
  });

  test("anything but one owner and repository is refused", () => {
    for (const value of ["", "flywheel", "wsauret/", "/flywheel", "wsauret/fly/wheel", "wsauret%2Fflywheel", "wsauret/flywheel/", " wsauret/flywheel", "wsauret/flywheel ", "-wsauret/flywheel", "wsauret-/flywheel", "wsauret/..", "wsauret/.", "wsauret/fly wheel", "wsauret/fly?wheel", "https://github.com/wsauret/flywheel"]) {
      expect(() => parseRepositoryIdentity(value)).toThrow(ReleaseManifestError);
    }
  });
});

describe("release manifest decoding", () => {
  test("unknown fields are tolerated and the platform asset is selected", () => {
    const raw = JSON.stringify({
      version: "1.2.3",
      channel: "stable",
      notes: { title: "reserved" },
      assets: [{ name: ASSET, url: assetUrl(), size: 1024, sha256: DIGEST, signature: "reserved" }],
    });

    expect(select(raw)).toEqual({
      version: { canonical: "1.2.3", precedence: { core: [1, 2, 3], prerelease: [] } },
      asset: { name: ASSET, url: assetUrl(), sizeBytes: 1024, sha256: DIGEST },
    });
  });

  test("a manifest far past every bound an earlier client set is read whole", () => {
    // v0.1.0 refused a manifest over 64 KiB, an asset over 512 MiB, any
    // version that was not strict major.minor.patch, and any asset URL but one
    // GitHub release path. None of them is this client's business.
    const raw = JSON.stringify({
      version: "2.0.0-rc.1+build.9",
      notes: "x".repeat(256 * 1024),
      signatures: [{ kind: "minisign", value: "reserved" }],
      assets: [
        { name: "release-notes.md", url: "https://cdn.example.com/notes" },
        { name: ASSET, url: "https://downloads.example.net:8443/flywheel/archive?token=1#part", size: 8 * 1024 * 1024 * 1024, sha256: DIGEST.toUpperCase(), compression: "gzip" },
      ],
    });

    expect(select(raw)).toEqual({
      version: { canonical: "2.0.0-rc.1", precedence: { core: [2, 0, 0], prerelease: ["rc", 1] } },
      asset: { name: ASSET, url: "https://downloads.example.net:8443/flywheel/archive?token=1#part", sizeBytes: 8 * 1024 * 1024 * 1024, sha256: DIGEST },
    });
  });

  test("text that is not JSON is refused", () => {
    expect(() => select("not json")).toThrow(ReleaseManifestError);
  });

  test("a manifest with nothing to verify is refused", () => {
    expect(() => select(JSON.stringify({ assets: [] }))).toThrow(ReleaseManifestError);
    expect(() => select(manifest({}, { sha256: undefined }))).toThrow(ReleaseManifestError);
    expect(() => select(manifest({}, { size: undefined }))).toThrow(ReleaseManifestError);
    expect(() => select(manifest({}, { sha256: "abc" }))).toThrow(ReleaseManifestError);
    expect(() => select(manifest({}, { size: 0 }))).toThrow(ReleaseManifestError);
    expect(() => select(manifest({}, { size: 1.5 }))).toThrow(ReleaseManifestError);
  });

  test("a version that cannot name a build directory is refused", () => {
    expect(() => select(manifest({ version: "../1.2.3" }))).toThrow(ReleaseManifestError);
    expect(() => select(manifest({ version: "" }))).toThrow(ReleaseManifestError);
  });

  test("a manifest that does not publish this platform is refused", () => {
    expect(() => select(manifest(), "flywheel-win32-arm64.tar.gz")).toThrow(ReleaseManifestError);
  });

  test("an asset URL that is not HTTPS is refused", () => {
    for (const url of ["http://github.com/wsauret/flywheel/releases/download/v1.2.3/flywheel-darwin-arm64.tar.gz", "ftp://github.com/x", "not-a-url"]) {
      expect(() => select(manifest({}, { url }))).toThrow(ReleaseManifestError);
    }
  });

  test("a refused URL is quoted by its origin and path only, so no credential or signature reaches a log", () => {
    expect(() => select(manifest({}, { url: "http://user:token@mirror.example.org/blob?X-Amz-Signature=secret#frag" }))).toThrow(/"http:\/\/mirror\.example\.org\/blob" does not use HTTPS$/);
  });
});

describe("the redirects a release request follows", () => {
  type Answer = (url: string) => Response;
  function publisher(answer: Answer) {
    const requested: string[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      requested.push(String(input));
      return answer(String(input));
    };
    return { requested, fetch };
  }
  const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } });

  test("a hop to any HTTPS host is followed", async () => {
    const chain = publisher((url) => (url === "https://github.com/a" ? redirect("https://mirror.example.org/b") : new Response("ok")));

    expect(await (await fetchOverHttps(chain.fetch, "https://github.com/a", new AbortController().signal)).text()).toBe("ok");
    expect(chain.requested).toEqual(["https://github.com/a", "https://mirror.example.org/b"]);
  });

  test("a hop to plain HTTP is refused and never requested", async () => {
    const chain = publisher(() => redirect("http://mirror.example.org/b"));

    await expect(fetchOverHttps(chain.fetch, "https://github.com/a", new AbortController().signal)).rejects.toThrow("does not use HTTPS");
    expect(chain.requested).toEqual(["https://github.com/a"]);
  });

  test("a refused hop and a hop with no target quote only the origin and path of their URLs", async () => {
    const plain = publisher(() => redirect("http://user:token@mirror.example.org/b?sig=secret"));
    const refusal = await fetchOverHttps(plain.fetch, "https://github.com/a?token=first", new AbortController().signal).catch(String);
    expect(refusal).toContain('"http://mirror.example.org/b" does not use HTTPS');
    expect(refusal).not.toContain("token");
    expect(refusal).not.toContain("secret");

    const nowhere = publisher(() => new Response(null, { status: 302 }));
    const unnamed = await fetchOverHttps(nowhere.fetch, "https://user:pw@github.com/a?sig=secret", new AbortController().signal).catch(String);
    expect(unnamed).toContain('"https://github.com/a" answered 302 and named no redirect target');
    expect(unnamed).not.toContain("secret");
    expect(unnamed).not.toContain("pw@");
  });

  test("every hop is reported as it answers, and the caller's headers go to each hop", async () => {
    const headers: (string | null)[] = [];
    const fetch = async (input: string | URL | Request, init?: { readonly headers?: { readonly [name: string]: string } }): Promise<Response> => {
      headers.push(init?.headers?.range ?? null);
      return String(input) === "https://github.com/a" ? redirect("https://mirror.example.org/b") : new Response("ok");
    };
    const hops: string[] = [];

    await fetchOverHttps(fetch, "https://github.com/a", new AbortController().signal, { headers: { range: "bytes=10-" }, onHop: (url) => { hops.push(url); } });
    expect(hops).toEqual(["https://github.com/a", "https://mirror.example.org/b"]);
    expect(headers).toEqual(["bytes=10-", "bytes=10-"]);
  });

  test("a chain of twenty hops, the Fetch standard's limit, is followed, and a loop past it is refused", async () => {
    let hop = 0;
    const twenty = publisher(() => (hop++ < 20 ? redirect(`https://mirror.example.org/${hop}`) : new Response("ok")));
    expect(await (await fetchOverHttps(twenty.fetch, "https://github.com/a", new AbortController().signal)).text()).toBe("ok");

    const loop = publisher(() => redirect("https://github.com/a"));
    await expect(fetchOverHttps(loop.fetch, "https://github.com/a", new AbortController().signal)).rejects.toThrow("redirected more than the 20 times");
    expect(loop.requested).toHaveLength(21);
  });
});
