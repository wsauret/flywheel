import type { CliCommandContext, CliNounContribution, CliVerb } from "../../../module-contract/cli-contribution.js"
import { REMOTE_USAGE } from "./usage.js"

type RemoteCli = typeof import("./index.js")

/** Load command implementations only after the module noun is admitted. */
function remoteVerb(syntax: string, description: string, run: (cli: RemoteCli, args: readonly string[], context: CliCommandContext) => Promise<void>): CliVerb {
  return { syntax, description, run: async (args, context) => run(await import("./index.js"), args, context) }
}

export const remoteNoun = {
  usage: REMOTE_USAGE,
  verbs: {
    pair: remoteVerb("pair [--relay <url>]", "Show a code that pairs a phone with this machine.", (cli, args, context) => cli.runPair(args, context)),
    devices: remoteVerb("devices [revoke <id>]", "List paired phones, or revoke one.", (cli, args, context) => cli.runDevices(args, context)),
    projects: remoteVerb("projects [forget <root>]", "List projects a phone can open, or forget one.", (cli, args, context) => cli.runProjects(args, context)),
    status: remoteVerb("status", "Show relay, paired device, and process initiation status.", (cli, _args, { directories, launcher }) => cli.runStatus(directories, launcher)),
    // This terminal is the device here, which this machine's own remote
    // access setting does not govern.
    machines: {
      syntax: "machines [add|forget]",
      description: "List, pair with, or forget the machines this terminal opens projects on.",
      runsWhileOff: true,
      run: async (args, { directories }) => (await import("./machines.js")).runMachines(args, directories),
    },
  },
} as const satisfies CliNounContribution
