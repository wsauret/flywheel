import { plugin } from "bun"

const initializationFailure = 'throw new Error("provider runtime initialized before command selection")'

async function instrumentInitialization(args: { path: string }, boundaries: readonly string[], instruction = initializationFailure) {
  let contents = await Bun.file(args.path).text()
  for (const boundary of boundaries) {
    const declaration = `export ${boundary}(`
    const declarationStart = contents.indexOf(declaration)
    const bodyStart = contents.indexOf("{", declarationStart + declaration.length)
    if (declarationStart < 0 || bodyStart < 0) throw new Error(`missing provider initialization boundary: ${boundary}`)
    contents = `${contents.slice(0, bodyStart + 1)}${instruction};${contents.slice(bodyStart + 1)}`
  }
  return { contents, loader: "ts" as const }
}

// This preload makes eager provider initialization observable through the real
// entry, while descriptor imports remain available for dynamic CLI help.
plugin({
  name: "cli-startup-import-boundary",
  setup(build) {
    if (process.env.FLYWHEEL_TEST_POISON_CLI_IMPORTS === "1") {
      build.onLoad({ filter: /[\\/]cli[\\/](?:startup|main)\.ts$/ }, () => ({
        contents: 'throw new Error("normal CLI composition imported before internal role dispatch")',
        loader: "js",
      }))
    }
    build.onLoad({ filter: /[\\/]agent-runtime[\\/]llm[\\/]client-factory\.ts$/ }, (args) =>
      instrumentInitialization(args, [
        "async function createAdmittedClient",
        "async function createClient",
      ]))
    build.onLoad({ filter: /[\\/]agent-runtime[\\/]llm[\\/]shared-provider-availability\.ts$/ }, (args) =>
      instrumentInitialization(args, ["function acquireSharedProviderAvailability"]))
    build.onLoad({ filter: /[\\/]infra[\\/]process-guardian\.ts$/ }, () => ({
      contents: 'export async function runProcessGuardianMain() { process.stdout.write("guardian selected\\n") }',
      loader: "js",
    }))
    build.onLoad({ filter: /[\\/]infra[\\/]owned-command-supervisor\.ts$/ }, args =>
      instrumentInitialization(args, ["async function runCommandSupervisorMain"],
        'process.stdout.write("command supervisor selected\\n"); process.exit(0)'))
    build.onLoad({ filter: /[\\/]cli[\\/]binary-install\.ts$/ }, () => ({
      contents: 'export async function runBinaryInstall() { process.stdout.write("binary install selected\\n"); return 0 }',
      loader: "js",
    }))
  },
})
