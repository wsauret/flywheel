import type { AnyBlock } from "../output-blocks.js";

/** A row that a turn's model output can open with, which can carry `turnStart`. */
type TurnOutputRow = Extract<AnyBlock, { readonly kind: "text" | "thinking" | "tool" | "agentGroup" | "question" }>;

function isTurnOutputRow(block: AnyBlock): block is TurnOutputRow {
  return block.kind === "text" || block.kind === "thinking" || block.kind === "tool" || block.kind === "agentGroup" || block.kind === "question";
}

/** The row marked as the first row of a turn that the runtime started; any other row as it is. */
export function withTurnStart(block: AnyBlock): AnyBlock {
  return isTurnOutputRow(block) ? { ...block, turnStart: true } : block;
}

function carriesTurnStart(block: AnyBlock | undefined): boolean {
  return block !== undefined && isTurnOutputRow(block) && block.turnStart === true;
}

/** `to`, marked when it takes the place of `from` and `from` carried the mark. */
export function keepTurnStart(from: AnyBlock | undefined, to: AnyBlock): AnyBlock {
  return carriesTurnStart(from) ? withTurnStart(to) : to;
}

/** The row without the mark, for a row that hands its mark to a row placed before it. */
export function withoutTurnStart(block: AnyBlock): AnyBlock {
  if (!isTurnOutputRow(block) || block.turnStart !== true) return block;
  const { turnStart: _moved, ...unmarked } = block;
  return unmarked;
}

/** The live output's wait for the first row of a turn that the runtime started. `arm` opens the wait, and `admit`
 *  marks the first row of output that enters after it. A person's message opens its own turn, so it ends the wait
 *  unmarked; a notice or a message from another session leaves it open. */
export function createTurnStartGate() {
  let armed = false;
  return {
    arm(): void {
      armed = true;
    },
    admit(block: AnyBlock): AnyBlock {
      if (!armed) return block;
      if (block.kind === "userMessage") {
        if (!block.pending && !block.injected && block.from === undefined) armed = false;
        return block;
      }
      if (!isTurnOutputRow(block)) return block;
      armed = false;
      return withTurnStart(block);
    },
  };
}
