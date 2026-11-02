import type { ShellWriteCommand, ShellOperand } from "./bash-write-effects.js";
import { expandShellFields, type ShellDialect } from "./bash-write-words.js";
import type { ShellState } from "./bash-write-state.js";

interface WriteArguments {
  readonly command: ShellWriteCommand;
  readonly indeterminate: boolean;
}

/** Materialize argv before selecting write operands. Each value retains its
 * expansion and original spelling for target placement. */
export function expandWriteArguments(command: ShellWriteCommand, state: ShellState, dialect: ShellDialect): WriteArguments {
  const operands: ShellOperand[] = [];
  let indeterminate = false;
  for (const raw of command.rawArgs) {
    const fields = expandShellFields(raw, key => state.lookup(key), dialect, state.changedIFS);
    if (fields === null) {
      indeterminate = true;
      operands.push({ raw, value: raw, word: null });
      continue;
    }
    for (const word of fields) {
      operands.push({ raw, value: word.value, word });
    }
  }
  const args = operands.map(operand => operand.value);
  return { command: { ...command, args, rawArgs: args, operands }, indeterminate };
}
