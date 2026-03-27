/**
 * Question Wiring — DRY extraction of question event subscription pattern.
 *
 * The pattern of creating a QuestionService, subscribing to question:asked/replied/rejected,
 * and cleaning up on teardown was duplicated 3x in flywheel-shell.tsx. This module extracts
 * it into a single factory following the `createX({ deps })` convention.
 */

import { QuestionService, type QuestionRequest } from "../../controller/question-service"
import type { EventBus, Unsubscribe } from "../../events/event-bus"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuestionWiringDeps {
  eventBus: EventBus
  onQuestion: (question: QuestionRequest) => void
  onClear: () => void
}

export interface QuestionWiring {
  /** The QuestionService instance (use for asking questions and rendering). */
  service: QuestionService
  /**
   * Clean up: reject all pending questions, unsubscribe from events.
   * Idempotent — safe to call multiple times.
   */
  cleanup: () => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQuestionWiring({ eventBus, onQuestion, onClear }: QuestionWiringDeps): QuestionWiring {
  const service = new QuestionService(eventBus)
  let cleaned = false

  const unsubs: Unsubscribe[] = [
    eventBus.subscribeToType("question:asked", () => {
      const pending = service.list()
      if (pending.length > 0) {
        onQuestion(pending[0])
      }
    }),
    eventBus.subscribeToType("question:replied", () => {
      onClear()
    }),
    eventBus.subscribeToType("question:rejected", () => {
      onClear()
    }),
  ]

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    // Unsubscribe from events
    for (const unsub of unsubs) unsub()
    // Clear display
    onClear()
    // Reject all pending questions (prevents queue deadlock)
    for (const pending of service.list()) {
      service.reject(pending.id)
    }
  }

  return { service, cleanup }
}
