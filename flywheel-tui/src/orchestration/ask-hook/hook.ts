#!/usr/bin/env bun
/**
 * Standalone hook entry — used only when running from source via
 * `bun <this-file>`. Shipped builds invoke the same logic via the
 * `flywheel ask-hook` subcommand (see src/cli/index.ts).
 */
import { runAskHook } from "./run.js";
import { errorMessage } from "../../infra/error-message.js";

runAskHook().catch((err) => {
  process.stderr.write(`flywheel-ask-hook: ${errorMessage(err)}\n`);
  process.exit(1);
});
