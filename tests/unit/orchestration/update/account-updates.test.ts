/**
 * The account's update coordinator as the account service composes it.
 *
 * Composition runs before the service listens, so it reads no configuration:
 * the policy is read when a view is first asked for. The coordinator holds no
 * config watch of its own; the account service's one watch calls
 * `refreshPolicy`. And a setting written while the coordinator is disposing
 * never reaches the durable policy.
 */

import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { globalConfigFile } from "../../../../src/infra/paths.js";
import type { GuardianControl } from "../../../../src/infra/process-supervisor.js";
import { ADMISSION_CLOSED_ERROR } from "../../../../src/orchestration/app-service/mutation-admission.js";
import { createAccountUpdates } from "../../../../src/orchestration/update/account-updates.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { systemUpdateScheduler } from "../../../../src/orchestration/update/update-check.js";
import type { UpdateStatusView } from "../../../../src/protocol/update-protocol-types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-account-updates-"));
const WORKER_URL = new URL("../../../../src/orchestration/app-service/worker-entry.ts", import.meta.url).href;

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const guardian: GuardianControl = {
  openGeneration: async () => { throw new Error("no update job runs in this case"); },
  pid: async () => process.pid,
};

let accounts = 0;
let accountHome = "";
let userDataRoot = "";

beforeEach(() => {
  accounts += 1;
  accountHome = path.join(TMP, `account-${accounts}`);
  userDataRoot = path.join(accountHome, ".flywheel");
  fs.mkdirSync(userDataRoot, { recursive: true });
});

function compose() {
  return createAccountUpdates({ userDataRoot, accountHome, workerUrl: WORKER_URL, guardian });
}

function writePolicy(autoInstall: boolean): void {
  fs.writeFileSync(globalConfigFile(userDataRoot), `[updates]\nauto_install = ${autoInstall}\n`);
}

test("composing the coordinator reads no configuration, and the account's config watch is what refreshes it", async () => {
  const updates = compose();
  try {
    // Written after composition: a coordinator that read the policy while it
    // was composed would still answer the default.
    writePolicy(false);
    expect(updates.status().autoInstall.persisted).toBe(false);

    writePolicy(true);
    updates.refreshPolicy();
    expect(updates.status().autoInstall.persisted).toBe(true);
  } finally {
    await updates.dispose();
  }
});

test("an auto-install write made once disposal started never reaches the policy", async () => {
  const updates = compose();

  const disposal = updates.dispose();
  const result = await updates.setAutoInstall(true, false);

  expect(result.ok ? undefined : result.error.message).toBe(ADMISSION_CLOSED_ERROR);
  expect(fs.existsSync(globalConfigFile(userDataRoot))).toBe(false);
  await disposal;
});

/** The release identity a release build compiles in: its version and, unless
 *  `repository` is undefined, the repository it updates from. */
function releaseIdentity(repository: string | undefined): () => void {
  const saved = { FLYWHEEL_APP_VERSION: process.env.FLYWHEEL_APP_VERSION, FLYWHEEL_UPDATE_REPOSITORY: process.env.FLYWHEEL_UPDATE_REPOSITORY, FLYWHEEL_REPO: process.env.FLYWHEEL_REPO };
  process.env.FLYWHEEL_APP_VERSION = "0.1.1";
  delete process.env.FLYWHEEL_REPO;
  if (repository === undefined) delete process.env.FLYWHEEL_UPDATE_REPOSITORY;
  else process.env.FLYWHEEL_UPDATE_REPOSITORY = repository;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}

test("a build that names no release repository checks nothing, reads no release notes, and says it does not update", async () => {
  const restore = releaseIdentity(undefined);
  fs.writeFileSync(globalConfigFile(userDataRoot), 'acknowledged_release_version = "0.1.0"\n', { mode: 0o600 });
  const owner = await createRuntimeConfigOwner({ userDataRoot, watch: false });
  const timers: Array<() => void> = [];
  const scheduler = spyOn(systemUpdateScheduler, "setTimer").mockImplementation((fire) => { timers.push(fire); return () => {}; });
  const network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
  const updates = compose();
  try {
    updates.start(owner);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(timers).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
    expect(updates.status().status).toEqual({ kind: "no-repository" });
    expect(updates.status().releaseNotice).toBeUndefined();
  } finally {
    await updates.dispose();
    await owner.dispose();
    scheduler.mockRestore();
    network.mockRestore();
    restore();
  }
});

test.each([false, true])("the account starts one notice unless a newer build was refused (refused: %s)", async (refused) => {
  const restore = releaseIdentity("wsauret/flywheel");
  if (refused) {
    fs.mkdirSync(path.join(userDataRoot, "update"), { mode: 0o700 });
    fs.writeFileSync(path.join(userDataRoot, "update", "refused-build.json"), JSON.stringify({ version: 1, refused: { version: "0.1.2", buildId: "refused-build" }, reason: "could not start" }), { mode: 0o600 });
  }
  fs.writeFileSync(globalConfigFile(userDataRoot), 'acknowledged_release_version = "0.1.0"\n', { mode: 0o600 });
  const owner = await createRuntimeConfigOwner({ userDataRoot, watch: false });
  const timers: Array<() => void> = [];
  const scheduler = spyOn(systemUpdateScheduler, "setTimer").mockImplementation((fire) => { timers.push(fire); return () => {}; });
  const network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json([{ tag_name: "v0.1.1", body: "Summary.\n\n## Added\n\n- A feature" }]));
  const updates = compose();
  const computed = Promise.withResolvers<void>();
  const published: UpdateStatusView[] = [];
  updates.subscribe((view) => {
    published.push(view);
    if (view.releaseNotice?.message.includes("Got")) computed.resolve();
  });
  try {
    updates.start(owner);
    updates.start(owner);
    expect(network).not.toHaveBeenCalled();
    const initialRevision = updates.status().revision;
    if (refused) {
      expect(updates.status().status).toEqual({ kind: "refused", version: "0.1.2" });
      expect(timers).toHaveLength(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(updates.status().releaseNotice).toBeUndefined();
      expect(owner.snapshot().config.acknowledged_release_version).toBe("0.1.0");
      expect(fs.readFileSync(globalConfigFile(userDataRoot), "utf8")).toBe('acknowledged_release_version = "0.1.0"\n');
      return;
    }
    expect(timers).toHaveLength(2);
    timers.at(-1)!();
    await computed.promise;
    const counted = updates.status();
    expect(counted.releaseNotice?.message).toBe("Updated to v0.1.1. Got 1 feature.");
    expect(published.at(-1)).toEqual(counted);
    expect(counted.revision).toBeGreaterThan(initialRevision);
    expect(published.filter((view) => view.releaseNotice !== undefined)).toHaveLength(1);
    // A newer build refused after the notice settled withdraws it at the next check.
    fs.mkdirSync(path.join(userDataRoot, "update"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(userDataRoot, "update", "refused-build.json"), JSON.stringify({ version: 1, refused: { version: "0.1.2", buildId: "refused-build" }, reason: "could not start" }), { mode: 0o600 });
    const refusal = Promise.withResolvers<void>();
    const stopWatching = updates.subscribe((view) => { if (view.status.kind === "refused") refusal.resolve(); });
    timers[0]!();
    await refusal.promise;
    stopWatching();
    expect(updates.status().releaseNotice).toBeUndefined();
    fs.rmSync(path.join(userDataRoot, "update", "refused-build.json"));
    await owner.mutate("acknowledgedReleaseVersion", "0.1.0", "0.1.1");
    expect(updates.status().releaseNotice).toBeUndefined();
    expect(updates.status().revision).toBeGreaterThan(counted.revision);
    expect(published.at(-1)).toEqual(updates.status());
  } finally {
    await updates.dispose();
    await owner.dispose();
    scheduler.mockRestore();
    network.mockRestore();
    restore();
  }
});
