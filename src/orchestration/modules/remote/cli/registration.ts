import type { CliCommandContext, CliNounContribution, CliVerb } from "../../../cli-contribution.js"

type RemoteCli = typeof import("./index.js")

export const REMOTE_USAGE = [
  "Usage: flywheel remote <pair|devices|projects|status|machines> [options]",
  "",
  "Pair a phone, or a terminal on another machine, with this machine so it can",
  "open this account's projects through the relay. Nothing on this machine",
  "listens: the runtime dials out to the relay, and every frame is sealed end",
  "to end.",
  "",
  "Verbs:",
  "  pair [--relay <url>]      Show a pairing code. The window stays open until a",
  "                            device pairs or the code expires.",
  "  devices [revoke <id>]     List paired devices, or revoke one.",
  "  projects [forget <root>]  List the projects a phone can start a runtime for,",
  "                            or stop offering one.",
  "  status                    Show the relay URL, the paired device count, and",
  "                            whether remote process initiation is on.",
  "  machines [add <link>|forget <machine>]",
  "                            On the terminal of another machine: list the",
  "                            machines this terminal is paired with and their",
  "                            projects, pair with the machine whose",
  "                            `flywheel remote pair` shows <link>, or forget",
  "                            one. `flywheel --remote` opens their projects.",
].join("\n")

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
