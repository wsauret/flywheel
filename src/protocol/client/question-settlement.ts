/**
 * How a client settles a pending ask_user call that the person skips, and how
 * the transcript reads each question of a settled call, so the terminal and
 * the web client resolve each question of one call independently and record
 * it in the same words (PI-INTERACTION-009).
 */

import type { AgentInputAnswer, AgentInputAnswers } from "../question-protocol-types.js"

/** What a skip sends: the answers the person already gave, or a cancel. */
export type QuestionSkip =
  | { readonly kind: "answer"; readonly answers: AgentInputAnswers }
  | { readonly kind: "cancel" }

/** The settlement a skip sends. `questions` holds each question of the call in
 *  order, with the complete answer the person gave it, or `undefined` for a
 *  question the skip leaves. The skip keeps the given answers: the call
 *  settles as answered, and the record marks each question without an answer
 *  as cancelled. A skip that leaves no question, or that has no answer to
 *  keep, cancels the whole call. */
export function questionSkip(questions: readonly (readonly [question: string, answer: AgentInputAnswer | undefined])[]): QuestionSkip {
  const given = questions.flatMap(([question, answer]) => answer ? [[question, answer] as const] : [])
  if (given.length === 0 || given.length === questions.length) return { kind: "cancel" }
  return { kind: "answer", answers: Object.fromEntries(given) }
}

/** One question of a question block as the transcript records it. */
export type QuestionRecordState =
  | { readonly kind: "answered"; readonly text: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "pending" }

/** A settled block marks each question without an answer as cancelled, both
 *  when the person cancelled the call and when a skip kept the answers to the
 *  other questions. A block that is not settled yet leaves the question
 *  pending. */
export function questionRecordState(block: { readonly answers?: { readonly [question: string]: string }; readonly cancelled?: boolean }, question: string): QuestionRecordState {
  const text = block.answers?.[question]
  if (text !== undefined) return { kind: "answered", text }
  return block.answers !== undefined || block.cancelled === true ? { kind: "cancelled" } : { kind: "pending" }
}
