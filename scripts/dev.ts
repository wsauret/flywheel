import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  copyNativeAssets,
  hostPlatformArch,
  nativeEnv,
  verifyNativeAssets,
} from "./binary-native-assets.js";
import { runningSourceSnapshot, sourceCheckout } from "../src/infra/platform/cli-subprocess.js";
import { createProcessTemporaryDirectory } from "../src/infra/process/process-temporary-directory.js";
import type { runSourceCli } from "./source-cli.js";

// The checkout this entry belongs to, which holds the native assets whether
// the entry runs from the checkout or from a snapshot of it.
const ROOT = sourceCheckout();
const platformArch = hostPlatformArch();
const nativeDir = await createProcessTemporaryDirectory("flywheel-native");

// The CLI ends most run modes with an explicit exit, so the staged assets are
// released from an exit hook rather than a finally block that would not run.
// A killed run fires no hook; the next source run's sweep removes its assets.
process.on("exit", () => { rmSync(nativeDir, { recursive: true, force: true }); });

await copyNativeAssets(ROOT, nativeDir, platformArch, { kind: "tracked-prebuilt" });
await verifyNativeAssets(nativeDir, platformArch);
Object.assign(process.env, nativeEnv(nativeDir));

// Every command runs from a snapshot of its checkout's source, fixed at its
// start, so an edit to the checkout never changes or breaks a running
// process: a terminal or a service that imports a module lazily, hours after
// its start, imports it from the same source as every module it already
// loaded (ARCH-DISTRIBUTION-030). An entry that already runs from a snapshot never takes
// another.
const entry = runningSourceSnapshot() === undefined
  ? await (await import("../src/infra/update/distribution/source-snapshot.js")).enterSourceSnapshot(ROOT)
  : undefined

// The CLI loads after the native environment is staged, from the tree this
// process runs.
const scripts = entry === undefined || entry.kind === "failed" ? import.meta.dir : join(entry.root, "scripts");
try {
  const source: { readonly runSourceCli: typeof runSourceCli } = await import(join(scripts, "source-cli.ts"));
  await source.runSourceCli(entry);
} catch (error) {
  // A failure that rejects here never reached the CLI's own fatal path: the
  // snapshot's CLI could not be imported, such as source with a syntax
  // error. A service start refuses that snapshot here, from this entry's own
  // modules, and exits to be restarted, so its manager's next start runs the
  // proved snapshot (PI-UPDATES-009). Everything else fails as it did.
  if (entry !== undefined && entry.kind !== "failed") {
    const [{ SERVE_EXIT, startsServiceProcess }, { refuseFailedServiceStart }, { errorMessage }] = await Promise.all([
      import("../src/cli/account-service/serve-contract.js"),
      import("../src/infra/update/distribution/source-snapshot.js"),
      import("../src/infra/diagnostics/error-message.js"),
    ]);
    if (startsServiceProcess(process.argv) && refuseFailedServiceStart(entry, errorMessage(error))) {
      process.stderr.write(`flywheel: failed to start: ${errorMessage(error)}\n`);
      process.exit(SERVE_EXIT.restart);
    }
  }
  throw error;
}
