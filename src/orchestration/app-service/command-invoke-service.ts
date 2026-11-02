import { randomUUID } from "node:crypto"
import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { OwnedCommandRunner } from "../../infra/owned-command.js"
import type { CommandOutcome, RuntimeCommandInvocation } from "../../protocol/command-catalog-protocol-types.js"
import type { FirstPartyModuleSnapshot, ModuleCommandMetadata } from "../modules.js"
import type { SessionManager } from "../session/manager.js"
import { recordedExecutionCwd } from "../session/session-execution-directory.js"
import { createSessionFactWriter, type SessionFactWriter } from "../session/session-fact-writer.js"
import type { SessionStore } from "../session-store/types.js"
import type { CommandCatalogProjection } from "./command-catalog-projection.js"
import type { CommandHost, CommandSession } from "./command-host.js"
import type { DefinitionAvailabilityOwner } from "./definition-availability.js"
import { skillMethod } from "./skill-method.js"
import { offCommandRefusal } from "../../protocol/client/off-command.js"
import { builtInCommandDeclarations, offCommandDescriptors } from "./kernel-commands.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"

const log = Log.create({ service: "command-invoke" })

export interface CommandInvokeDeps {
  /** The published roster; its revision is the one an invocation must echo. */
  readonly catalog: Pick<CommandCatalogProjection, "snapshot">
  readonly moduleSelection: FirstPartyModuleSnapshot
  readonly manager: Pick<SessionManager, "read">
  readonly sessionStore: Pick<SessionStore, "get" | "appendPreRunnerOutput">
  readonly supervisor: Pick<RuntimeSupervisor, "activateSession" | "compactChat" | "ensureChatRunner" | "forkSession" | "interruptSession" | "requestChatContext" | "reviewChat" | "sendChat">
  /** The published skill availability a command's method resolves against. */
  readonly availability: Pick<DefinitionAvailabilityOwner, "snapshot">
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  readonly directories: ProjectDirectories
  readonly authDirectory: () => string
  readonly runOwnedCommand?: OwnedCommandRunner
}

export interface CommandInvokeService {
  invoke(mutation: RuntimeCommandInvocation): Promise<CommandOutcome>
}

interface ResolvedSession {
  readonly session: CommandSession
  /** Releases what the session lent the handler, after the outcome settles. */
  dispose(): void
}

/** Executes built-in commands in the runtime (ARCH-PROTOCOL-037, ARCH-STRUCTURE-017). A command is
 *  found by id in the same enabled composition that published its descriptor,
 *  so enabling a module is the whole registration and no id is switched on
 *  here. Invocations that name a session run one at a time per session, so
 *  two commands cannot interleave their reads and turns on one conversation. */
export function createCommandInvokeService(deps: CommandInvokeDeps): CommandInvokeService {
  const lanes = new Map<string, Promise<CommandOutcome>>()

  function serialized(sessionId: string, work: () => Promise<CommandOutcome>): Promise<CommandOutcome> {
    const previous = lanes.get(sessionId) ?? Promise.resolve<CommandOutcome>({ kind: "none" })
    // `work` never rejects (execute maps every throw to a warning), so the lane
    // promise is safe to chain from and to drop without a rejection handler.
    const next = previous.then(work)
    lanes.set(sessionId, next)
    void next.then(() => { if (lanes.get(sessionId) === next) lanes.delete(sessionId) })
    return next
  }

  async function resolveSession(sessionId: string): Promise<ResolvedSession | undefined> {
    const durable = await deps.manager.read(sessionId)
    if (durable?.kind !== "chat") return undefined
    const executionCwd = recordedExecutionCwd(durable, deps.directories.projectRoot)
    let facts: SessionFactWriter | undefined
    const resident = async (): Promise<boolean> => deps.sessionStore.get(sessionId)?.kind === "chat" || await deps.supervisor.activateSession(sessionId)
    return {
      session: {
        id: sessionId,
        executionCwd,
        prompt: ({ text, label, args, context }) => deps.supervisor.requestChatContext(sessionId, { text, invocation: { label, ...(args === undefined ? {} : { args }) } }, context),
        async startMethod({ skill, label, args }) {
          const method = skillMethod(skill, args, deps.availability.snapshot())
          if (method.kind === "unavailable") return { kind: "warning", message: `${label} cannot start the ${skill} skill: ${method.reason}.` }
          // Committed like a person's message, not as request-only context: the
          // method governs every later turn of the conversation it starts.
          const sent = await deps.supervisor.sendChat(sessionId, { text: method.text, invocation: { label, ...(args === undefined ? {} : { args }) } })
          return sent.ok ? { kind: "none" } : { kind: "warning", message: sent.reason }
        },
        async systemLine(message, level = "info") {
          if (await resident()) deps.sessionStore.appendPreRunnerOutput(sessionId, { kind: "system", id: randomUUID(), message, level, timestamp: Date.now() })
        },
        review: () => deps.supervisor.reviewChat(sessionId),
        interrupt: () => {
          void deps.supervisor.interruptSession(sessionId, "person").catch((error: unknown) => { log.warn("command interrupt failed", { sessionId, error: errorMessage(error) }) })
        },
        compact: () => deps.supervisor.compactChat(sessionId),
        fork: () => deps.supervisor.forkSession(sessionId),
        runtime(handle) {
          const entry = deps.sessionStore.get(sessionId)
          return entry?.kind === "chat" ? entry.runner?.moduleRuntimes?.get(handle) : undefined
        },
        async host(handle) {
          if (!await resident()) return undefined
          const runner = await deps.supervisor.ensureChatRunner(sessionId)
          return runner.chatModuleHosts.get(handle)
        },
        facts: () => (facts ??= createSessionFactWriter({ sessionId, writer: deps.eventWriter })),
        readInFlight: (kinds) => deps.projectionReader.readInFlight(sessionId, kinds),
      },
      dispose: () => { facts?.dispose() },
    }
  }

  async function execute(command: ModuleCommandMetadata, resolved: ResolvedSession | undefined, argument: string | undefined): Promise<CommandOutcome> {
    const host: CommandHost = {
      session: resolved?.session,
      directories: deps.directories,
      authDirectory: deps.authDirectory,
      projectionReader: deps.projectionReader,
      runOwnedCommand: deps.runOwnedCommand,
    }
    try {
      // A client of an earlier release asks even for a command that only
      // opens a surface, since it does not read `opens` from the catalog.
      return "opens" in command ? { kind: "open", surface: command.opens } : await command.execute(host, argument)
    } catch (error) {
      log.warn("command failed", { command: command.id, sessionId: resolved?.session.id, error: errorMessage(error) })
      return { kind: "warning", message: errorMessage(error) }
    } finally {
      resolved?.dispose()
    }
  }

  return {
    async invoke(mutation) {
      if (mutation.revision !== deps.catalog.snapshot().revision) return { kind: "stale" }
      const modules = deps.moduleSelection()
      const command = builtInCommandDeclarations(modules).find((candidate) => candidate.id === mutation.id)
      if (!command) return { kind: "unavailable", message: offCommandRefusal(offCommandDescriptors(modules), mutation.id) ?? `"/${mutation.id}" is not available to invoke` }
      if (mutation.sessionId === undefined) return execute(command, undefined, mutation.argument)
      const resolved = await resolveSession(mutation.sessionId)
      if (!resolved) return { kind: "unavailable", message: `"/${mutation.id}" needs a chat session, and ${mutation.sessionId} is not one` }
      return serialized(mutation.sessionId, () => execute(command, resolved, mutation.argument))
    },
  }
}
