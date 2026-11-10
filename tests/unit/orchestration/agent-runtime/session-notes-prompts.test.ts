import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Schema } from "effect";
import {
  renderSessionNotesAutoCompactFallback,
  renderSessionNotesGuidance,
  renderSessionNotesReminder,
  SESSION_NOTES_AUTO_COMPACT_FALLBACK_TEMPLATE,
  SESSION_NOTES_GUIDANCE_TEMPLATE,
  SESSION_NOTES_REMINDER_TEMPLATE,
} from "../../../../src/infra/agent-assets/session-notes.js";
import { promptCapabilities } from "../../../helpers/prompt-capabilities.js";

const TOKEN_BUDGET_KEYS = ["reminder_message_template", "guidance_message", "auto_compact_fallback_prompt"] as const;
const CODEX_MODELS = resolve("inspiration/codex/codex-rs/models-manager/models.json");

interface ReplacementLedger {
  reminder_message_template: readonly (readonly [string, string])[]
  guidance_message: readonly (readonly [string, string])[]
  auto_compact_fallback_prompt: readonly (readonly [string, string])[]
}

const TokenBudgetFixtureSchema = Schema.Struct({
  reminder_message_template: Schema.String,
  guidance_message: Schema.String,
  auto_compact_fallback_prompt: Schema.String,
});
const ModelsSchema = Schema.Struct({
  models: Schema.Array(Schema.Unknown),
});
const ModelSchema = Schema.Struct({
  model_messages: Schema.Struct({ token_budget: TokenBudgetFixtureSchema }),
});

const REPLACEMENTS = {
  reminder_message_template: [
    ["save concise progress notes with the `notes` tool", "save your current state with `checkpoint_replace`, one section at a time"],
    ["You should write or append notes in a way to best help you recover in a new context window. It is also a good idea to clean up your old notes if they become obsolete or irrelevant.", "Maintain notes in a way to best help you recover in a new context window. Remove obsolete information when updating them."],
    [" with the goal, decisions, progress, learnings, next steps, and the window ID and item ID of every relevant user request still being solved, as well as important actions/tool calls for future reference.", "{request_reference_clause}, as well as important actions/tool calls for future reference. {skill_checkpoint_guidance} {design_intent_guidance}"],
    ["Note that every non-assistant item, such as user, developer, tool response, has an item id `[id: ...]` that is immediately after its item content.", "{recall_guidance}"],
    ["Future context windows will not automatically include the current conversation.", "Compaction starts a fresh context without a generated summary; prior conversation messages are not carried into it."],
    ["After saving your state, call `functions.new_context` to continue in a fresh context window.", "After saving your state, continue the task."],
    ["Maintain notes in a way to best help you recover in a new context window. Remove obsolete information when updating them.", "Maintain the checkpoint in a way to best help you recover in a new context window. Remove obsolete information when updating it."],
  ],
  guidance_message: [
    ["use `notes` to maintain a concise checkpoint of the goal, decisions, progress, learnings and next steps.", "use `checkpoint_read` to read your conversation's checkpoint and `checkpoint_replace` to replace one section. Use `checkpoint_decide` to add each dated decision in the user's words, naming the decision it replaces. The fixed sections are Design intent, Decisions, Current state, Open questions, Next step, Relevant skills, References, and Working notes. The complete checkpoint is limited to 24,576 UTF-8 bytes. A write over the limit is refused with its size and the limit; curate it, never discard intent to save tokens. {skill_checkpoint_guidance} {design_intent_guidance}"],
    ["Include the window ID and item ID for every relevant user request you are currently solving as well as important actions/tool calls.", "{request_reference_guidance}"],
    ["You can use `history` tool to look up details with the references later.", "{recall_guidance}"],
    ["Note that every non-assistant item, such as user, developer, tool response, has an item id `[id: ...]` that is immediately after its item content.", "{keep_references}"],
    ["Relative note paths belong to the current thread; absolute paths may read other threads' notes, but writes are limited to the current thread.", "Use only the scoped checkpoint tools, not Markdown files or ordinary project file tools. Only you change your checkpoint; children report through handoffs."],
    ["You can also use `get_context_remaining` tool to find the remaining token budget for better planning.", "Compaction starts a fresh context without a generated summary; prior conversation messages are not carried into it."],
    ["Once the token budget is exhausted, you will lose access to the current window and continue in a fresh context window and you can only recover through `notes` and `history` tools.", "Once the token budget is exhausted, recover details from the checkpoint{recall_recovery_source}."],
    ["If Previous context window id is present in `<context_window>`, it means a context reset occurred and this is a new window. After a reset, read the checkpoint and use the read-only `history` tool to recover any missing details. When a window ID and item ID are known, prefer `read_item` directly; when they are missing or uncertain, use `list_items`, or `search_contents` to locate the item first.", "{recovery_guidance}"],
    ["Treat notes and history as internal bookkeeping. Do not mention them in user-facing messages.", "Treat the checkpoint{recall_bookkeeping} as internal bookkeeping. Do not mention it in user-facing messages."],
    ["It is a good idea to take incremental notes while you work", "It is a good idea to update the checkpoint incrementally while you work"],
    ["{recovery_guidance}", "{recovery_guidance} {skill_reload_guidance}"],
  ],
  auto_compact_fallback_prompt: [
    ["The next window will not automatically include this conversation.", "Compaction starts a fresh context without a generated summary; prior conversation messages are not carried into it."],
    ["Make exactly one write or append call to `notes` now", "Save the checkpoint now: optionally use only `checkpoint_read` in the first response to recover saved context, then use `checkpoint_replace` or `checkpoint_decide` to save the sections that changed"],
    [" with the goal, decisions, progress, learnings, next steps, and the window ID and item ID of every relevant user request still being solved, as well as important actions/tool calls for future reference.", "{request_reference_clause}, as well as important actions/tool calls for future reference. Read existing content before replacing it. Preserve saved user intent; if you cannot recover it, leave the existing checkpoint intact rather than replace it with empty recovery prose. {skill_checkpoint_guidance} {design_intent_guidance}"],
    ["Note that every non-assistant item, such as user, developer, tool response, has an item id `[id: ...]` that is immediately after its item content.", "{recall_guidance}"],
    ["After the notes result returns, call `functions.new_context`; do not use any tools other than `notes` and `functions.new_context`.", "After saving, continue in the next context; do not use other tools in this exhausted context."],
    [" to save a concise checkpoint", ""],
  ],
} satisfies ReplacementLedger;

function applyLedger(source: string, ledger: readonly (readonly [string, string])[]): string {
  return ledger.reduce((text, [from, to]) => {
    expect(text.split(from)).toHaveLength(2);
    return text.replace(from, to);
  }, source);
}

describe("session notes prompt adaptations", () => {
  it("preserves relevant skill references and restores their context in every recovery mode", () => {
    for (const recall of [[{ name: "recall" }], []]) {
      const input = { has: promptCapabilities([{ name: "skill" }, ...recall]) };
      for (const rendered of [
        renderSessionNotesReminder({ ...input, remainingTokens: 321 }),
        renderSessionNotesGuidance(input),
        renderSessionNotesAutoCompactFallback(input),
      ]) {
        expect(rendered).toContain('Keep a short "Relevant skills" section');
        expect(rendered).toContain("exact IDs of loaded skills that still apply");
        expect(rendered).toContain("one short reason each remains relevant");
        expect(rendered).toContain("Remove skills for completed phases");
        expect(rendered).toContain("Do not copy skill bodies into the checkpoint");
        expect(rendered).toContain('Keep a clearly labeled "Design intent" section and keep it first');
        expect(rendered).toContain("each rejected alternative with its reason");
        expect(rendered).toContain("A rejected alternative and a replaced decision are never obsolete");
        expect(rendered).toContain("update it as discussion, inspection, and experiments change the understood intent, and mark the version the user approved as approved");
        expect(rendered).toContain("this section is the exact design intent you revise drafts against");
      }
      expect(renderSessionNotesGuidance(input)).toContain("reassess the listed skills and explicitly reload those that still apply with the `skill` tool before resuming work");
    }
  });

  it("names no skill bookkeeping for an agent that cannot load skills, and keeps the design intent", () => {
    const input = { has: promptCapabilities([{ name: "recall" }]) };
    for (const rendered of [
      renderSessionNotesReminder({ ...input, remainingTokens: 321 }),
      renderSessionNotesGuidance(input),
      renderSessionNotesAutoCompactFallback(input),
    ]) {
      expect(rendered).not.toContain('Keep a short "Relevant skills" section');
      expect(rendered).not.toContain("with the `skill` tool");
      expect(rendered).toContain('Keep a clearly labeled "Design intent" section and keep it first');
      expect(rendered).not.toMatch(/ {2}| \n/);
    }
  });

  it.skipIf(!existsSync(CODEX_MODELS))("matches the Codex token-budget strings with only the approved substitutions", () => {
    const parsed: unknown = JSON.parse(readFileSync(CODEX_MODELS, "utf8"));
    const source = Schema.decodeUnknownSync(ModelsSchema)(parsed);
    const firstModel = Schema.decodeUnknownSync(ModelSchema)(source.models[0]);
    const tokenBudget = firstModel.model_messages.token_budget;
    const adapted = {
      reminder_message_template: SESSION_NOTES_REMINDER_TEMPLATE,
      guidance_message: SESSION_NOTES_GUIDANCE_TEMPLATE,
      auto_compact_fallback_prompt: SESSION_NOTES_AUTO_COMPACT_FALLBACK_TEMPLATE,
    };

    for (const key of TOKEN_BUDGET_KEYS) {
      const expected = applyLedger(tokenBudget[key], REPLACEMENTS[key]);
      expect(adapted[key]).toBe(expected);
    }
  });

  it("renders token parameters and only available recovery capabilities", () => {
    const input = { has: promptCapabilities([{ name: "recall" }, { name: "skill" }]) };
    const reminder = renderSessionNotesReminder({ ...input, remainingTokens: 321 });
    const guidance = renderSessionNotesGuidance(input);
    const fallback = renderSessionNotesAutoCompactFallback(input);

    expect(reminder).toContain("only 321 tokens remain");
    for (const rendered of [reminder, guidance, fallback]) {
      expect(rendered).toContain("`checkpoint_replace`");
      expect(rendered).toContain("recall");
      expect(rendered).not.toMatch(/`notes`|history tool|get_context_remaining|new_context/);
    }
    expect(guidance).toContain("After compaction, the recorded checkpoint opens the fresh context. Use the read-only `recall` tool to recover any missing details.");
    expect(guidance).toContain("When a durable entry ID is known, prefer `expand` directly; when it is missing or uncertain, use `recall` with no query, or search terms to locate the item first.");
    expect(guidance).not.toContain("Recent session notes");

    const withoutRecall = renderSessionNotesGuidance({ has: promptCapabilities([{ name: "skill" }]) });
    expect(withoutRecall).not.toContain("recall");
    expect(withoutRecall).toContain("After compaction, the recorded checkpoint opens the fresh context.");
  });

});
