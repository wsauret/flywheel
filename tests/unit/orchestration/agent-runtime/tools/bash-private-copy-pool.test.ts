/** The one private copy Worker of a pool: started at the first job, replaced
 *  after it ends, and ended with the pool. */

import { describe, expect, it, spyOn } from "bun:test";
import { serialize } from "bun:jsc";
import * as fs from "node:fs";
import * as path from "node:path";

import { createBoundedWorkerSpawner } from "../../../../../src/infra/bounded-worker-spawner.js";
import type { OwnedCommandRunner } from "../../../../../src/infra/owned-command.js";
import { detectCopyChanges, takePrivateProjectCopy } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js";
import { createPrivateCopyPool } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy-pool.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const createDirectory = temporaryDirectories();
const notGit: OwnedCommandRunner = async () => ({ exitCode: 128, stdout: "", stdoutBytes: new Uint8Array(), stderr: "", timedOut: false });

describe("the private copy Worker of a pool", () => {
  /** A pool whose Workers come from the role's own bounded spawner, each kept
   *  with whether it closed, over a project of `files` files. `exchanged`
   *  answers the serialized bytes of every message to and from its Workers. */
  function countedPool(files = 1) {
    const bounded = createBoundedWorkerSpawner("bash-private-copy");
    const workers: { readonly worker: Worker; closed: boolean }[] = [];
    let received = 0;
    const sent: unknown[][][] = [];
    const pool = createPrivateCopyPool({
      spawn: (specifier, options) => {
        const worker = bounded(specifier, options);
        const spawned = { worker, closed: false };
        worker.addEventListener("close", () => { spawned.closed = true; }, { once: true });
        worker.addEventListener("message", (event: MessageEvent) => { received += serialize(event.data).byteLength; });
        sent.push(spyOn(worker, "postMessage").mock.calls);
        workers.push(spawned);
        return worker;
      },
    });
    const root = fs.realpathSync(createDirectory("bash-private-copy-pool-worker-"));
    fs.writeFileSync(path.join(root, "a.ts"), "source\n");
    for (let i = 1; i < files; i++) fs.writeFileSync(path.join(root, `file-${String(i).padStart(4, "0")}.ts`), "more\n");
    let homes = 0;
    const take = () => takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home: path.join(root, ".flywheel", "edits", `h${++homes}`), runGit: notGit, guard: "none", jobs: pool.jobs, pool });
    const exchanged = () => received + sent.flat().reduce((bytes, [message]) => bytes + serialize(message).byteLength, 0);
    return { pool, workers, take, exchanged };
  }

  it("starts one Worker for ten takes", async () => {
    const { pool, workers, take } = countedPool();
    for (let i = 0; i < 10; i++) expect(fs.readFileSync(path.join((await take()).copyRoot, "a.ts"), "utf8")).toBe("source\n");
    expect(workers.length).toBe(1);
    await pool.close();
  });

  it("fails the job of a Worker that ends before it answered, and starts a new Worker for the next job", async () => {
    const { pool, workers, take } = countedPool();
    const read = pool.jobs.run({ kind: "read", home: createDirectory("bash-private-copy-ended-") });
    workers[0]!.worker.terminate();
    await expect(read).rejects.toThrow("the private copy Worker ended before it answered");
    expect(fs.readFileSync(path.join((await take()).copyRoot, "a.ts"), "utf8")).toBe("source\n");
    expect(workers.length).toBe(2);
    await pool.close();
  });

  it("lets a landing in flight finish its jobs on the Worker before disposal ends it, and lands a later landing on a Worker of its own", async () => {
    const { pool, workers, take } = countedPool();
    const { home } = await take();
    const resumed = Promise.withResolvers<void>();
    const inFlight = pool.landing(async landingJobs => {
      await resumed.promise;
      return (await landingJobs.run({ kind: "read", home })).kind;
    });
    let closed = false;
    const closing = pool.close().then(() => { closed = true; });
    await Bun.sleep(5);
    expect(closed).toBe(false);
    resumed.resolve();

    expect(await inFlight).toBe("recorded");
    await closing;
    expect(workers.map(spawned => spawned.closed)).toEqual([true]);
    expect(await pool.landing(async landingJobs => (await landingJobs.run({ kind: "read", home })).kind)).toBe("recorded");
    expect(workers.length).toBe(1);
  });

  it("exchanges no more with its Worker for a take and its landing's scan of 400 files than of 10", async () => {
    const measured = async (files: number) => {
      const { pool, take, exchanged } = countedPool(files);
      const copy = await take();
      await detectCopyChanges(copy, pool.jobs);
      await pool.close();
      return exchanged();
    };
    const few = await measured(10);
    expect(await measured(400) - few).toBeLessThan(256);
  });

  it("scans a copy that a new Worker holds nothing of with the entries of its record", async () => {
    const { pool, workers, take } = countedPool();
    const copy = await take();
    const ended = Promise.withResolvers<void>();
    workers[0]!.worker.addEventListener("close", () => ended.resolve(), { once: true });
    workers[0]!.worker.terminate();
    await ended.promise;
    fs.writeFileSync(path.join(copy.copyRoot, "a.ts"), "changed\n");

    const scanned = await detectCopyChanges(copy, pool.jobs);

    expect(workers.length).toBe(2);
    expect(scanned.changes.map(change => [change.path, change.expected.kind])).toEqual([["a.ts", "file"]]);
    await pool.close();
  });

  it("ends its Worker when the pool is disposed, and refuses a later take", async () => {
    const { pool, workers, take } = countedPool();
    await take();
    await pool.close();
    expect(workers.map(spawned => spawned.closed)).toEqual([true]);
    await expect(take()).rejects.toThrow("the private copy Worker is closed");
    expect(workers.length).toBe(1);
  });
});
