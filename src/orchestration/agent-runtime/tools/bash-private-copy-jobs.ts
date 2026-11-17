import { createBoundedWorkerSpawner } from "../../../infra/bounded-worker-spawner.js";
import { embeddedEntrySpecifier, runsThroughBun } from "../../../infra/cli-subprocess.js";
import { terminateWorker } from "../../../infra/worker-termination.js";
import type { StateDigest } from "./bash-copy-repository-state.js";
import type { CopyRecordRead, FinalizedCopy, PrivateCopyAnswer, PrivateCopyJob, PrivateCopyReply, PrivateCopyRequest, ScannedChanges, TakenTree } from "./bash-private-copy-tree.js";
import type { SessionFolderObservation } from "./bash-session-observation.js";

/** What each kind of job answers. */
interface PrivateCopyValues {
  readonly copy: TakenTree;
  readonly scan: ScannedChanges;
  readonly session: SessionFolderObservation;
  readonly read: CopyRecordRead;
  readonly finalize: FinalizedCopy;
  readonly forget: undefined;
  readonly topology: StateDigest;
  readonly index: StateDigest;
}

/** A copy job of a reused copy whose state the Worker no longer holds: it
 *  dropped the state to stay bounded, or it is a new Worker. An expected
 *  miss, not a failure; the take takes a new copy. */
export class PrivateCopyStateDropped extends Error {
  override readonly name = "PrivateCopyStateDropped";

  constructor() {
    super("the private copy Worker no longer holds the state of the reused copy");
  }
}

/** The private copy Worker of one owner: a pool, or a command that has none. */
export interface PrivateCopyJobs {
  /** Runs one job on the owner's Worker, which starts at the first job and
   *  runs the jobs one at a time in the order they arrive. `onGitReady`, for a
   *  copy job, runs once the Worker wrote the private Git files, and the job
   *  answers only after it settled. A Worker that fails or ends fails each job
   *  it holds, and the next job starts a new one. Rejects with the job's
   *  failure, with `PrivateCopyStateDropped` for a reuse the Worker holds no
   *  state of, and always after `close`. Index bytes transfer to the Worker; the
   *  caller must not reuse their buffer. */
  run<K extends PrivateCopyJob["kind"]>(job: Extract<PrivateCopyJob, { readonly kind: K }>, onGitReady?: () => Promise<void>): Promise<PrivateCopyValues[K]>;
  /** Refuses every later job, waits for the jobs in flight, then ends the
   *  Worker and joins it. Never rejects. */
  close(): Promise<void>;
}

export type SpawnWorker = (specifier: string | URL, options?: WorkerOptions) => Worker;

type Settled = Exclude<PrivateCopyAnswer, { readonly kind: "git-ready" }>;

/** Bun's Worker, whose `ref` and `unref` the DOM lib type that this project compiles against does not declare. */
type BunWorker = Worker & { ref(): void; unref(): void };

/** A started Worker and the jobs it holds, by id. */
interface LiveWorker {
  readonly worker: BunWorker;
  readonly jobs: Map<number, { readonly settle: (answer: Settled) => void; readonly gitReady: () => void }>;
}

/** Creates the job runner of one owner. `spawn` is a seam for tests. The
 *  runner keeps one bounded spawner for its whole life, so the generation
 *  budget of the role bounds how many Workers that ended early it replaces. */
export function createPrivateCopyJobs(spawn: SpawnWorker = createBoundedWorkerSpawner("bash-private-copy")): PrivateCopyJobs {
  let current: LiveWorker | undefined;
  let closed = false;
  let nextId = 0;
  const inFlight = new Set<Promise<unknown>>();
  const terminations = new Set<Promise<void>>();

  const end = (worker: Worker): void => {
    const termination = terminateWorker(worker);
    terminations.add(termination);
    void termination.then(() => terminations.delete(termination));
  };

  const start = (): LiveWorker => {
    // An idle Worker never keeps the process alive; one that holds a job does.
    // SAFETY: every Worker that Bun starts has `ref` and `unref`; only the DOM lib type that this project compiles against omits them.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Bun's Worker has ref and unref, which the DOM lib type does not declare
    const worker = spawn(privateCopyWorkerSpecifier(), { name: "bash-private-copy", smol: true, ref: false }) as BunWorker;
    const live: LiveWorker = { worker, jobs: new Map() };
    const fail = (message: string): void => {
      if (current === live) current = undefined;
      for (const job of live.jobs.values()) job.settle({ kind: "failed", message });
      live.jobs.clear();
    };
    worker.addEventListener("message", (event: MessageEvent<PrivateCopyReply>) => {
      const { id, answer } = event.data;
      const job = live.jobs.get(id);
      if (!job) return;
      if (answer.kind === "git-ready") {
        job.gitReady();
        return;
      }
      live.jobs.delete(id);
      if (live.jobs.size === 0) worker.unref();
      job.settle(answer);
    });
    worker.addEventListener("error", (event) => {
      if (current !== live) return;
      fail(`the private copy Worker failed: ${event.message || "it reported no cause"}`);
      end(worker);
    });
    worker.addEventListener("close", () => fail("the private copy Worker ended before it answered"), { once: true });
    return live;
  };

  const run = async (job: PrivateCopyJob, onGitReady?: () => Promise<void>): Promise<PrivateCopyValues[PrivateCopyJob["kind"]]> => {
    if (closed) throw new Error("the private copy Worker is closed");
    current ??= start();
    const live = current;
    const id = nextId++;
    const answered = Promise.withResolvers<Settled>();
    let initialization: Promise<{ readonly kind: "ready" } | { readonly kind: "failed"; readonly message: string }> = Promise.resolve({ kind: "ready" });
    live.jobs.set(id, {
      settle: answered.resolve,
      gitReady: () => {
        if (onGitReady) initialization = onGitReady().then(() => ({ kind: "ready" }), error => ({ kind: "failed", message: error instanceof Error ? error.message : String(error) }));
      },
    });
    live.worker.ref();
    live.worker.postMessage({ id, job } satisfies PrivateCopyRequest, job.kind === "index" ? [job.bytes.buffer] : []);
    const settled = (async () => {
      const answer = await answered.promise;
      // A failed job still waits for the Git setup it started, which writes into the copy's home.
      const initialized = await initialization;
      if (answer.kind === "dropped") throw new PrivateCopyStateDropped();
      if (answer.kind === "failed") throw new Error(answer.message);
      if (initialized.kind === "failed") throw new Error(initialized.message);
      return answer.value;
    })();
    inFlight.add(settled);
    try {
      return await settled;
    } finally {
      inFlight.delete(settled);
    }
  };

  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the Worker answers each kind of job with that kind's value
    run: run as PrivateCopyJobs["run"], // SAFETY: the Worker (`bash-private-copy-worker.ts`) answers each kind of job with the value that `PrivateCopyValues` names for it.
    async close() {
      closed = true;
      await Promise.allSettled(inFlight);
      if (current) end(current.worker);
      current = undefined;
      await Promise.all(terminations);
    },
  };
}

function privateCopyWorkerSpecifier(): string {
  return runsThroughBun(process.execPath)
    ? new URL("bash-private-copy-worker.ts", import.meta.url).href
    : embeddedEntrySpecifier(import.meta.dir, "bash-private-copy-worker.js");
}
