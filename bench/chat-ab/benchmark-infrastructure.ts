import { join } from "node:path";
import * as ownership from "../../src/infra/container-mark.js";
import { bytesIdentity, directoryIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { REPO_ROOT } from "./harness-paths.js";
import { benchmarkHarnessIdentity } from "./source-treatment.js";

/** Refuse unsupported source revisions before admitting a model or starting benchmark work. */
export function requireStrictBenchmarkSettlement(): void {
  if (!("enableStrictDescendantSettlement" in ownership) || typeof ownership.enableStrictDescendantSettlement !== "function") {
    throw new Error("This source revision lacks strict descendant cleanup; select a current compatible revision");
  }
  ownership.enableStrictDescendantSettlement();
}

/** The fixed controller's launch authority is infrastructure, not a source treatment. */
export async function benchmarkInfrastructureIdentity(repoRoot = REPO_ROOT): Promise<string> {
  const [infra, cli, benchmark, protocol, manifest, lock, guardianEntry, moduleCatalog, harness] = await Promise.all([
    directoryIdentity(join(repoRoot, "src/infra")),
    directoryIdentity(join(repoRoot, "src/cli")),
    directoryIdentity(join(repoRoot, "src/orchestration/modules/development/benchmark")),
    directoryIdentity(join(repoRoot, "src/protocol")),
    Bun.file(join(repoRoot, "package.json")).bytes(),
    Bun.file(join(repoRoot, "bun.lock")).bytes(),
    Bun.file(join(repoRoot, "scripts/source-cli.ts")).bytes(),
    Bun.file(join(repoRoot, "src/orchestration/module-catalog.ts")).bytes(),
    benchmarkHarnessIdentity(repoRoot),
  ]);
  return structuredIdentity({
    infra, cli, benchmark, protocol, harness, manifest: bytesIdentity(manifest), lock: bytesIdentity(lock),
    guardianEntry: bytesIdentity(guardianEntry), moduleCatalog: bytesIdentity(moduleCatalog),
    bun: Bun.version, platform: process.platform, architecture: process.arch,
  });
}
