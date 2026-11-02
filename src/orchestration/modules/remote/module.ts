import { serveLaneFor } from "../../../infra/cli-subprocess.js"
import { REMOTE_COMMAND, REMOTE_COMMAND_NAME, REMOTE_SURFACE, remoteProtocol } from "../../../protocol/modules/remote.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import { remoteNoun } from "./cli/registration.js"
import { remoteConfigSection } from "./config.js"
import { createRemoteProtocol } from "./protocol.js"
import { createRemoteService, remoteService } from "./service.js"
import { createAccountRelayService, retiredServiceInstallation } from "./account-relay-service.js"
import { servedClientOf } from "./relay-control-channel.js"
import { createKeepAwake, NO_KEEP_AWAKE } from "./keep-awake.js"
import { configSection } from "../../config/config-section.js"

export const remoteModule = {
  id: "remote", dependencies: [], availability: { kind: "available" },
  host: "account",
  service: { handle: remoteService, create: createRemoteService },
  protocol: moduleProtocol({ contract: remoteProtocol, create: createRemoteProtocol }),
  contributions: [
    {
      domain: "accountServices", id: "remote", value: {
        retiredInstallation: retiredServiceInstallation,
        configuration: (config) => configSection(config, remoteConfigSection).keep_awake,
        create: (options) => {
          const config = configSection(options.config, remoteConfigSection)
          return createAccountRelayService({
            userDataRoot: options.userDataRoot,
            lane: serveLaneFor(process.execPath),
            version: options.version,
            client: servedClientOf(options.webClient),
            registry: options.registry,
            projects: options.projects,
            projectClone: options.projectClone,
            keepAwake: config.keep_awake
              ? createKeepAwake({ platform: process.platform, spawnOwned: (command) => options.launcher.scope.spawnOwned(command) })
              : NO_KEEP_AWAKE,
          })
        },
      },
    },
    { domain: "cli", id: "remote", value: remoteNoun },
    // This machine's terminal pairs as a device of other machines. The code
    // loads only for a launch that offers or opens a project on one.
    { domain: "terminalRemote", id: "remote", value: { load: async () => (await import("./terminal-remote.js")).terminalRemote } },
    { domain: "config", id: remoteConfigSection.key, value: remoteConfigSection },
    { domain: "commands", id: REMOTE_COMMAND, value: { id: REMOTE_COMMAND, title: REMOTE_COMMAND_NAME, description: "Pair a phone and manage remote access", aliases: ["pair", "phone"], menu: { group: "top", rank: 80 }, opens: REMOTE_SURFACE } },
    { domain: "settings", id: "remote", value: { control: "binary", group: "Remote", label: "Remote access", description: "Access this machine from paired devices" } },
    { domain: "settings", id: "remote-keep-awake", value: { control: "config-boolean", section: remoteConfigSection.key, key: "keep_awake", defaultValue: true, group: "Remote", label: "Keep Awake For Phone", description: "Keep this machine awake while a phone uses a runtime it started?" } },
  ],
  observers: [], transformers: [], gates: [],
} as const satisfies FirstPartyModule
