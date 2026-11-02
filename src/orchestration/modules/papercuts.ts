import { papercutDisposeDefinition, papercutLogDefinition } from "./papercuts/tools.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import type { RuntimeTool } from "../agent-runtime/tools/types.js"
import { papercutsProtocol } from "../../protocol/modules/papercuts.js"
import { moduleProtocol } from "../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../modules.js"
import { buildPapercutDrain } from "./papercuts/drain.js"
import { createPapercutsProtocol } from "./papercuts/protocol.js"
import { PapercutRecordedFactSchemas } from "./papercuts/facts.js"
import { requireGuardedEventAppender } from "../../infra/event-store-types.js"
import { createPapercutDispositionWriter, papercutDispositionRuntime, papercutDispositionService } from "./papercuts/disposition-writer.js"
import type { ModuleProcessServices } from "../app-service/module-service-host.js"
import type { ModuleRuntimeServices } from "../agent-runtime/module-runtime-services.js"

function declaration(tool: RuntimeTool, registryOrder: number): ToolDeclaration {
  return {
    category: "ambient",
    action: tool.action,
    cloneInheritance: "inherit",
    learningReviewExecutable: false,
    semanticBundle: null,
    personaBaseline: false,
    registryOrder,
    registrations: { [tool.name]: { capabilities: [], create: () => ({ tool }) } },
  }
}

export const papercutsModule = {
  id: "papercuts",
  dependencies: [],
  availability: { kind: "available" },
  service: {
    handle: papercutDispositionService,
    create: (services: Pick<ModuleProcessServices, "projectionReader" | "eventWriter">) => ({
      writer: createPapercutDispositionWriter({
        store: services.projectionReader,
        writer: requireGuardedEventAppender(services.eventWriter, "papercut disposition requires the runtime event store's writer"),
      }),
      // The kernel owns the shared writer and closes it after module disposal.
      dispose: async () => {},
    }),
  },
  runtime: {
    handle: papercutDispositionRuntime,
    create: (services: Pick<ModuleRuntimeServices, "modules">) => services.modules.get(papercutDispositionService)?.writer,
  },
  protocol: moduleProtocol({ contract: papercutsProtocol, create: createPapercutsProtocol }),
  facts: { prefixes: ["papercut."], sessionSchemas: () => PapercutRecordedFactSchemas },
  contributions: [
    { domain: "settings", id: "papercuts", value: { control: "binary", label: "Papercuts", description: "Log problems in the open repository; drain them with /papercuts" } },
    { domain: "tools", id: papercutLogDefinition.name, value: { kind: "tool", name: papercutLogDefinition.name, declaration: declaration(papercutLogDefinition, 90) } },
    { domain: "tools", id: papercutDisposeDefinition.name, value: { kind: "tool", name: papercutDisposeDefinition.name, declaration: declaration(papercutDisposeDefinition, 91) } },
    { domain: "commands", id: "papercuts", value: {
      id: "papercuts",
      title: "Papercuts",
      description: "Drain project papercuts in the foreground chat, with any words that follow the command as direction",
      aliases: [],
      execute: async (host, argument) => {
        const session = host.session
        if (!session) return { kind: "warning", message: "No active chat session" }
        const drain = await buildPapercutDrain(host.projectionReader, session.id)
        if (drain.kind !== "ready") {
          await session.systemLine(drain.message)
          return { kind: "none" }
        }
        const direction = argument?.trim() || undefined
        const text = direction ? `Run the project papercut campaign.\n\n${direction}` : "Run the project papercut campaign."
        const delivered = await session.prompt({ text, label: "/papercuts", ...(direction ? { args: direction } : {}), context: drain.context })
        return delivered ? { kind: "none" } : { kind: "warning", message: `Unable to drain project papercuts in ${session.id}` }
      },
    } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
