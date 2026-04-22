/**
 * 3-step conversation summarizer for context recovery.
 *
 * When free tokens fall below the proactive threshold, compresses
 * conversation history via: summary -> questions -> answers.
 * Returns a compact message list and handoff prompt for the next turn.
 */

import { Log } from "../../../../../infra/log.js";
import type { LLMClient, Message } from "../llm/types.js";
import { createTokenCounter } from "./token-counter.js";

const log = Log.create({ service: "harness-summarizer" });

const PROACTIVE_SUMMARIZATION_PERCENT = 85;
const UNWIND_TARGET_FREE_TOKENS = 4_000;

export interface Handoff {
  messages: Message[];
  userPrompt: string;
}

interface Summarizer {
  shouldSummarize(currentTokens: number, contextLimit: number): boolean;
  summarize(
    messages: ReadonlyArray<Message>,
    instruction: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<Handoff | null>;
}

export function createSummarizer(client: LLMClient): Summarizer {
  return {
    shouldSummarize(currentTokens: number, contextLimit: number): boolean {
      return currentTokens > contextLimit * (PROACTIVE_SUMMARIZATION_PERCENT / 100);
    },

    async summarize(
      messages: ReadonlyArray<Message>,
      instruction: string,
      cwd: string,
      signal?: AbortSignal,
    ): Promise<Handoff | null> {
      if (messages.length === 0) return null;

      log.info("starting 3-step summarization", { messageCount: messages.length });

      const summaryPrompt = `You are about to hand off your work to another AI agent.
Provide a comprehensive summary of progress on this task:

Original Task: ${instruction}

Cover:
1. **Major Actions Completed** -- commands run, what each revealed.
2. **Important Information Learned** -- file locations, configs, errors, system state.
3. **Challenging Problems Addressed** -- issues encountered and how resolved.
4. **Current Status** -- exactly where you are in task completion.

Be comprehensive. The next agent needs to understand everything that happened.`;

      const summary = await client.complete([...messages, { role: "user", content: summaryPrompt }]);

      if (signal?.aborted) {
        log.info("summarization aborted after step 1");
        return null;
      }

      const questionPrompt = `You are picking up work from a previous AI agent on this task:

**Original Task:** ${instruction}

**Summary from Previous Agent:**
${summary}

**Current Working Directory:** ${cwd}

Ask several questions (at least five, more if necessary) about the current state of the solution that are not answered above. After this you are on your own -- ask everything you need.`;

      const questions = await client.complete([{ role: "user", content: questionPrompt }]);

      if (signal?.aborted) {
        log.info("summarization aborted after step 2");
        return null;
      }

      const answers = await client.complete([
        ...messages,
        { role: "user", content: summaryPrompt },
        { role: "assistant", content: summary },
        { role: "user", content: `The next agent has questions, please answer each in detail:\n\n${questions}` },
      ]);

      log.info("summarization complete");

      return {
        messages: [
          { role: "user", content: questionPrompt },
          { role: "assistant", content: questions },
        ],
        userPrompt:
          `Here are the answers the other agent provided.\n\n${answers}\n\n` +
          `Continue working on this task from where the previous agent left off. ` +
          `You can no longer ask questions. Follow the spec to interact with the shell.`,
      };
    },
  };
}

/**
 * Remove oldest message pairs to make room for new content.
 * Keeps index 0 (initial task instruction), removes from index 1 forward.
 */
export function unwindMessages(messages: Message[], contextLimit: number): void {
  const counter = createTokenCounter();
  for (const msg of messages) counter.addMessage(msg);
  let currentTokens = counter.total;

  while (messages.length > 1 && contextLimit - currentTokens < UNWIND_TARGET_FREE_TOKENS) {
    const splicedCount = Math.min(2, messages.length - 1);
    const spliced = messages.splice(1, splicedCount);
    const splicedCounter = createTokenCounter();
    for (const msg of spliced) splicedCounter.addMessage(msg);
    currentTokens -= splicedCounter.total;
  }
}
