import type { FrontendOutputBlock, FrontendToolStreamingText } from "./app-service-types.js"

const utf8Encoder = new TextEncoder()

export function frontendUtf8Bytes(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

export function frontendToolStreamingTextBytes(body: FrontendToolStreamingText): number {
  if ("proposedDiff" in body) return frontendUtf8Bytes(JSON.stringify(body.proposedDiff))
  if (body.previewCheck !== undefined) return frontendUtf8Bytes(body.previewCheck)
  return frontendUtf8Bytes(body.content) + (body.filetype === undefined ? 0 : frontendUtf8Bytes(body.filetype))
}

export function frontendOutputBlockBytes(block: FrontendOutputBlock): number {
  switch (block.kind) {
    case "text":
    case "thinking":
    case "userMessage":
      return frontendUtf8Bytes(block.content) + 64
    case "system":
      return frontendUtf8Bytes(block.message) + 64
    case "divider":
      return frontendUtf8Bytes(block.label) + 64
    case "degraded":
      return frontendUtf8Bytes(block.notice) + frontendUtf8Bytes(block.eventType) + 64
    case "tool":
      return frontendUtf8Bytes(block.name) + frontendUtf8Bytes(block.presentation.name) + frontendUtf8Bytes(block.presentation.detail) + (block.invocationBody ? frontendUtf8Bytes(block.invocationBody.content) : 0) + (block.content ? frontendUtf8Bytes(block.content) : 0) + (block.diff ? frontendUtf8Bytes(block.diff) : 0) + 128
    case "agentGroup":
      return block.label.length + block.description.length + (block.status === "error" ? block.failure.title.length + block.failure.message.length + block.failure.guidance.length + (block.failure.detail?.length ?? 0) : 0) + block.children.reduce((sum, child) => sum + frontendOutputBlockBytes(child), 128)
    case "question":
      return block.questions.reduce((sum, question) => sum + question.question.length + question.choices.reduce((choiceSum, choice) => choiceSum + choice.label.length, 0), 128)
  }
}
