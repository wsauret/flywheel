import type { LauncherScope } from "../../src/infra/process-supervisor.js";

/** A launcher for a test whose code path must start no process: every launch throws. */
export const refusingLauncher: LauncherScope = {
  spawnOwned: () => Promise.reject(new Error("no process launch in this test")),
  adoptOwned: () => Promise.reject(new Error("no process adoption in this test")),
  open: () => refusingLauncher,
  close: async () => ({ settled: true }),
};
