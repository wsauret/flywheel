// A person-facing script entry in its smallest form: it starts the command
// launcher, runs one owned process, and prints one line of its own. It
// configures no diagnostics sink, as a bench or scripts/ entry does not.
import { createCliLauncher } from "../../src/cli/runtime-launch.js"
import { runOwnedCommand } from "../../src/infra/owned-command.js"

const launcher = await createCliLauncher()
try {
  await runOwnedCommand(launcher.scope, [process.execPath, "--version"])
  console.log("the entry's own line")
} finally {
  await launcher.dispose()
}
process.exit(0)
