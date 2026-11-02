import { SIDE_QUESTION_COMMAND, SIDE_QUESTION_COMMAND_NAME, SIDE_QUESTION_SURFACE, sideQuestionProtocol } from "../../../protocol/modules/side-question.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import { sideQuestionHost } from "./host.js"
import { createChatSideQuestions } from "./request.js"
import { createSideQuestionProtocol } from "./protocol.js"

export const sideQuestionModule = {
  id: "side-question",
  dependencies: [],
  availability: { kind: "available" },
  protocol: moduleProtocol({ contract: sideQuestionProtocol, create: createSideQuestionProtocol }),
  contributions: [
    { domain: "chatHosts", id: "side-question", value: { handle: sideQuestionHost, create: createChatSideQuestions } },
    { domain: "commands", id: SIDE_QUESTION_COMMAND, value: {
      id: SIDE_QUESTION_COMMAND,
      title: SIDE_QUESTION_COMMAND_NAME,
      description: "Ask the question that follows the command on the side, without interrupting the main chat",
      aliases: [],
      execute: async (host, argument) => {
        const session = host.session
        const current = await session?.host(sideQuestionHost)
        if (!session || !current) return { kind: "unavailable", message: "Side questions need an open chat" }
        if (argument?.trim()) await current.ask(argument)
        return { kind: "open", surface: SIDE_QUESTION_SURFACE, sessionId: session.id }
      },
    } },
    { domain: "settings", id: "side-question", value: { control: "binary", group: "Tools", label: "Side questions", description: "Ask temporary contextual questions with /btw" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
