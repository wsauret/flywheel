/** The fake publisher, runtime, and account every update-install test drives
 *  one transfer against, on a real filesystem. */

import { afterEach, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { setContainedDirectoryBackendForTests } from "../../../../src/infra/descriptor-directory.js";
import { Log } from "../../../../src/infra/log.js";
import type { OwnedProcess } from "../../../../src/infra/owned-subprocess.js";
import type { LauncherScope, OwnershipClosure } from "../../../../src/infra/process-supervisor.js";
import { computeBuildId } from "../../../../src/infra/update/build-identity.js";
import { parseReleaseVersion } from "../../../../src/infra/update/version-order.js";
import type { UpdateAuthority } from "../../../../src/infra/update/update-authority.js";
import type { SelectedRelease } from "../../../../src/infra/update/release-manifest.js";
import type { UpdateScheduler } from "../../../../src/orchestration/update/update-check.js";
import { createUpdateInstaller } from "../../../../src/orchestration/update/update-install.js";
import { fakeFetch } from "../../../helpers/fake-fetch.js";
import { placedBuildVersionAnswer } from "../../../helpers/placed-build.js";
import { tarBlocks, type TarEntrySpec } from "../../../helpers/tar-archive.js";

export const VERSION = "1.4.0";
const PLATFORM = "linux";
// A musl build: its target names its C library, and every name the update
// derives from the target (the asset, the archive root, the native directory)
// carries that name through.
export const PLATFORM_ARCH = "linux-x64-musl";
const ASSET_NAME = `flywheel-${PLATFORM_ARCH}.tar.gz`;
export const ASSET_URL = `https://github.com/acme/flywheel/releases/download/v${VERSION}/${ASSET_NAME}`;
export const STALL_MS = 60_000;
/** How long no byte may arrive, across every request, before a transfer
 *  gives up. */
export const GIVE_UP_MS = 10 * 60_000;

/** The account one test installs into, fresh for each test. A test may point
 *  `wrapperDir` elsewhere before it builds its harness. */
export const account = { home: "", userDataRoot: "", wrapperDir: "" };

/** Give every test of the calling file a fresh account, and remove it, with
 *  every fake the test installed, afterwards. */
export function useFreshAccount(): void {
  beforeEach(() => {
    account.home = mkdtempSync(join(tmpdir(), "flywheel-update-install-"));
    account.userDataRoot = join(account.home, ".flywheel");
    account.wrapperDir = join(account.home, "bin");
    mkdirSync(account.userDataRoot, { recursive: true });
  });

  afterEach(async () => {
    setContainedDirectoryBackendForTests(undefined);
    await Log.closeGlobal();
    rmSync(account.home, { recursive: true, force: true });
  });
}

// --- the archive a publisher serves -----------------------------------------

export interface PayloadFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string | Uint8Array;
}

const PAYLOAD_DIRS = ["native", `native/${PLATFORM_ARCH}`, "fonts", "webview"] as const;
const PAYLOAD_FILES: readonly PayloadFile[] = [
  { path: "flywheel-bin", mode: 0o755, content: "#!/bin/sh\nexit 0\n" },
  { path: `native/${PLATFORM_ARCH}/libsharp.so`, mode: 0o644, content: "native" },
  { path: "fonts/argon.otf", mode: 0o644, content: "font" },
  { path: "webview/index.html", mode: 0o644, content: "<!doctype html>" },
];

/** The archive the release build produces: one root named after the asset,
 *  holding the installer script and the `build` payload. */
export async function buildArchive(options: { readonly extra?: readonly TarEntrySpec[]; readonly version?: string; readonly payload?: readonly PayloadFile[]; readonly metadata?: { readonly [key: string]: unknown }; readonly root?: string } = {}): Promise<Uint8Array> {
  const staged = mkdtempSync(join(tmpdir(), "flywheel-payload-"));
  const payloadFiles = [...PAYLOAD_FILES, ...options.payload ?? []];
  try {
    for (const dir of PAYLOAD_DIRS) mkdirSync(join(staged, dir), { recursive: true });
    for (const file of payloadFiles) {
      writeFileSync(join(staged, file.path), file.content);
      chmodSync(join(staged, file.path), file.mode);
    }
    const buildId = await computeBuildId(staged, process.platform);
    const metadata = `${JSON.stringify({ version: options.version ?? VERSION, buildId, asset: ASSET_NAME, ...options.metadata }, null, 2)}\n`;

    const root = options.root ?? `flywheel-${PLATFORM_ARCH}`;
    const entries: TarEntrySpec[] = [
      { name: `${root}/`, typeflag: "5", mode: 0o755 },
      { name: `${root}/install.sh`, typeflag: "0", mode: 0o755, content: "#!/usr/bin/env bash\n" },
      { name: `${root}/build/`, typeflag: "5", mode: 0o755 },
      ...PAYLOAD_DIRS.map((dir): TarEntrySpec => ({ name: `${root}/build/${dir}/`, typeflag: "5", mode: 0o755 })),
      ...payloadFiles.map((file): TarEntrySpec => ({ name: `${root}/build/${file.path}`, typeflag: "0", mode: file.mode, content: file.content })),
      { name: `${root}/build/build.json`, typeflag: "0", mode: 0o644, content: metadata },
      ...(options.extra ?? []),
    ];
    return gzipSync(tarBlocks(entries));
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

export function releaseOf(archive: Uint8Array): SelectedRelease {
  const version = parseReleaseVersion(VERSION);
  if (!version) throw new Error("the fixture version is not a release version");
  return {
    version,
    asset: { name: ASSET_NAME, url: ASSET_URL, sizeBytes: archive.byteLength, sha256: createHash("sha256").update(archive).digest("hex") },
  };
}

// --- the runtime around one attempt -----------------------------------------

interface FakeTimer {
  readonly fire: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

/** A scheduler on fake time. `advance` moves the clock and fires every live
 *  timer whose delay has passed; `fire` fires the newest live timer of one
 *  delay at once. */
function testScheduler() {
  const timers: (FakeTimer & { readonly atMs: number })[] = [];
  let now = 10_000;
  const scheduler: UpdateScheduler = {
    nowMs: () => now,
    setTimer: (fire, delayMs) => {
      const timer = { fire, delayMs, atMs: now + delayMs, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
  return {
    scheduler,
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
      for (const timer of timers) {
        if (timer.cancelled || timer.atMs > now) continue;
        timer.cancelled = true;
        timer.fire();
      }
    },
    fire: (delayMs: number) => {
      const live = timers.filter((timer) => !timer.cancelled && timer.delayMs === delayMs);
      const latest = live.at(-1);
      if (!latest) throw new Error(`no live timer waits ${delayMs}ms`);
      latest.cancelled = true;
      latest.fire();
    },
  };
}

interface FakeLauncher {
  readonly scope: LauncherScope;
  readonly launches: readonly (readonly string[])[];
  opened: number;
  closed: number;
  spawned: number;
}

/** How one launched command answers: its exit code and what it prints. */
interface CommandAnswer {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Every command succeeds, and a placed build answers its version the way a
 *  working build does. */
function realBuild(command: readonly string[]): CommandAnswer {
  const version = placedBuildVersionAnswer(command);
  return version === undefined ? { code: 0 } : { code: 0, stdout: version };
}

function testLauncher(answer: (command: readonly string[]) => CommandAnswer = realBuild): FakeLauncher {
  const launches: string[][] = [];
  const state = { opened: 0, closed: 0, spawned: 0, launches };
  const child: LauncherScope = {
    spawnOwned: (command) => {
      state.spawned += 1;
      state.launches.push([...command]);
      const answered = answer(command);
      const exit = { code: answered.code, signal: null, statusOf: "payload", ownership: "surrendered" } as const;
      const stream = (text = "") => new ReadableStream<Uint8Array>({
        start(controller) {
          if (text !== "") controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
      const process: OwnedProcess = {
        pid: 7,
        token: "owned:update-installer",
        stdin: undefined,
        stdout: stream(answered.stdout),
        stderr: stream(answered.stderr),
        exited: Promise.resolve(exit),
        terminate: () => Promise.resolve(exit),
      };
      return Promise.resolve(process);
    },
    open: () => child,
    adoptOwned: () => Promise.reject(new Error("the installer adopts nothing")),
    close: (): Promise<OwnershipClosure> => { state.closed += 1; return Promise.resolve({ settled: true }); },
  };
  const scope: LauncherScope = {
    spawnOwned: child.spawnOwned,
    adoptOwned: child.adoptOwned,
    open: () => { state.opened += 1; return child; },
    close: () => Promise.resolve({ settled: true }),
  };
  return {
    scope,
    get launches() { return state.launches; },
    get opened() { return state.opened; },
    get closed() { return state.closed; },
    get spawned() { return state.spawned; },
  };
}

interface FakeAuthority {
  readonly authority: UpdateAuthority;
  readonly activations: number;
  readonly disposals: number;
}

function testAuthority(fence: number): FakeAuthority {
  const state = { activations: 0, disposals: 0 };
  const authority: UpdateAuthority = {
    claim: () => ({ kind: "won", fence, leaseExpiresAtMs: 70_000 }),
    renew: () => "held",
    commitCheck: () => true,
    commitActivation: ({ fence: given, activate }) => {
      if (given !== fence) return false;
      activate();
      state.activations += 1;
      return true;
    },
    dispose: () => { state.disposals += 1; },
  };
  return { authority, get activations() { return state.activations; }, get disposals() { return state.disposals; } };
}

type FetchAnswer = (url: string, signal: AbortSignal, range: string | undefined) => Response;

/** A body that pulls one chunk from `chunks` only when the reader asks, as
 *  a socket delivers it, so a test's hook between chunks runs in read order. */
function streamOf(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) { await iterator.return?.(reason); },
  }, { highWaterMark: 0 });
}

export function bodyOf(chunks: readonly Uint8Array[], beforeChunk?: (index: number) => Promise<void>): Response {
  async function* stream(): AsyncIterable<Uint8Array> {
    for (const [index, chunk] of chunks.entries()) {
      await beforeChunk?.(index);
      yield chunk;
    }
  }
  return new Response(streamOf(stream()));
}

/** A body the connection cuts after `chunks`, as a reset socket does. */
export function cutBody(chunks: readonly Uint8Array[]): Response {
  /** @yields {Uint8Array} each chunk, before the connection resets. */
  async function* stream(): AsyncIterable<Uint8Array> {
    yield* chunks;
    throw new Error("the connection was reset");
  }
  return new Response(streamOf(stream()));
}

/** A `206` answer holding `archive` from byte `start`. */
export function rangeOf(archive: Uint8Array, start: number): Response {
  const headers = new Headers({ "content-range": `bytes ${start}-${archive.byteLength - 1}/${archive.byteLength}` });
  return new Response(bodyOf([archive.subarray(start)]).body, { status: 206, headers });
}

/** A `206` answer holding `archive` from byte `start` to `end`, which the
 *  connection cuts there unless `end` is the end of the asset. */
export function cutRangeOf(archive: Uint8Array, start: number, end: number): Response {
  const headers = new Headers({ "content-range": `bytes ${start}-${archive.byteLength - 1}/${archive.byteLength}` });
  const body = end === archive.byteLength ? bodyOf([archive.subarray(start)]) : cutBody([archive.subarray(start, end)]);
  return new Response(body.body, { status: 206, headers });
}

/** A `206` answer that states `archive` from byte `start` to its end but
 *  holds only the bytes to `end`, and then ends with no error. */
export function shortRangeOf(archive: Uint8Array, start: number, end: number): Response {
  const headers = new Headers({ "content-range": `bytes ${start}-${archive.byteLength - 1}/${archive.byteLength}` });
  return new Response(bodyOf([archive.subarray(start, end)]).body, { status: 206, headers });
}

/** The first byte a `range: bytes=<n>-` request asks for. */
export function rangeFrom(range: string | undefined): number {
  return range === undefined ? 0 : Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? Number.NaN);
}

/** One body delivered in `count` pieces, so a test can look at the account
 *  while the publisher still owes bytes. */
export function pieces(archive: Uint8Array, count: number): readonly Uint8Array[] {
  const size = Math.ceil(archive.byteLength / count);
  return Array.from({ length: count }, (_unused, index) => archive.subarray(index * size, Math.min((index + 1) * size, archive.byteLength)));
}

/** An HTTP answer that is not a success, with no body. */
export function rejection(status: number): Response {
  return new Response(null, { status });
}

export function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

// A publisher that answers, then never delivers another byte.
export function stallingBody(signal: AbortSignal, chunks: readonly Uint8Array[] = []): Response {
  async function* stream(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("the request was aborted"));
        return;
      }
      signal.addEventListener("abort", () => { reject(new Error("the request was aborted")); }, { once: true });
    });
  }
  return new Response(streamOf(stream()));
}

interface Harness {
  readonly install: (release: SelectedRelease, signal?: AbortSignal) => Promise<{ readonly kind: "installed" | "revoked" }>;
  readonly launcher: FakeLauncher;
  readonly authority: FakeAuthority;
  readonly scheduler: ReturnType<typeof testScheduler>;
  requests: string[];
  /** The `range` each request asked for, or `undefined` for the whole asset. */
  ranges: (string | undefined)[];
}

export function harness(answer: FetchAnswer, commands?: (command: readonly string[]) => CommandAnswer): Harness {
  const launcher = testLauncher(commands);
  const authority = testAuthority(9);
  const scheduler = testScheduler();
  const requests: string[] = [];
  const ranges: (string | undefined)[] = [];
  const installer = createUpdateInstaller({
    userDataRoot: account.userDataRoot,
    wrapperDir: account.wrapperDir,
    platform: PLATFORM,
    platformArch: PLATFORM_ARCH,
    scheduler: scheduler.scheduler,
    policy: { read: () => ({ persisted: true, forcedOff: false, effective: true }), revalidate: async (decide) => decide({ persisted: true, forcedOff: false, effective: true }) },
    launcher: launcher.scope,
    openAuthority: () => authority.authority,
    fetch: fakeFetch((url, init) => {
      const range = new Headers(init?.headers).get("range") ?? undefined;
      const signal = init?.signal ?? undefined;
      if (signal === undefined) throw new Error("the installer asks every request with its abort signal");
      requests.push(String(url));
      ranges.push(range);
      return Promise.resolve(answer(String(url), signal, range));
    }),
  });
  return {
    launcher,
    authority,
    scheduler,
    requests,
    ranges,
    install: (release, signal) => installer.install({ release, fence: 9, signal: signal ?? new AbortController().signal }),
  };
}

/** Moves fake time in `stepMs` steps until `settled` settles, so every wait
 *  the transfer schedules elapses as it would on a real clock. */
export async function settleOnFakeTime<T>(run: Harness, settled: Promise<T>, stepMs: number): Promise<T> {
  const ended = settled.then(() => true, () => true);
  for (let step = 0; step < 10_000; step += 1) {
    if (await Promise.race([ended, Bun.sleep(1).then(() => false)])) break;
    run.scheduler.advance(stepMs);
  }
  return settled;
}

export function versionsEntries(): readonly string[] {
  const versions = join(account.userDataRoot, "versions");
  return existsSync(versions) ? readdirSync(versions) : [];
}

/** Every regular file below `dir`, so a refusal can be asked what it left. */
export function filesUnder(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]
  ));
}

// --- what the account looks like afterwards ---------------------------------

// The engine under test installs a POSIX build: a `flywheel-bin` payload whose
// execute bit it proves, and a shell wrapper it publishes, so these cases need
// a POSIX host to mean anything. A Windows build through the same engine has
// its own coverage in windows-install.test.ts.
export const POSIX_HOST = process.platform !== "win32";
