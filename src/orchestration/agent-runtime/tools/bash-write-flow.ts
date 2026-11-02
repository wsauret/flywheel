import type { Node } from "web-tree-sitter";
import { ShellState } from "./bash-write-state.js";
import { expandShellFields, type ExpandedWord, type ShellDialect } from "./bash-write-words.js";

export interface ShellFlow {
  readonly success: ShellState;
  readonly failure: ShellState;
}

export interface ShellTransfers {
  readonly dialect: ShellDialect;
  command(node: Node, children: readonly Node[], state: ShellState, depth: number): Promise<ShellFlow>;
  redirect(node: Node, state: ShellState): void;
  finish(state: ShellState, depth: number): Promise<void>;
  spend(): void;
}

/** A statement without a modeled status-dependent transfer has one state. */
export function shellFlow(state: ShellState): ShellFlow { return { success: state, failure: state }; }

/** Fold only where control rejoins, not between operands of an AND/OR list. */
export function joinShellFlow(flow: ShellFlow): ShellState {
  if (flow.success === flow.failure) return flow.success;
  const state = flow.success.copy();
  state.merge([flow.success, flow.failure]);
  return state;
}

/** The enclosing substitution owns nested substitutions and its shell state. */
export function shellSubstitutions(root: Node): readonly Node[] {
  const pending = [root];
  const found: Node[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (node.type === "command_substitution" || node.type === "process_substitution") found.push(node);
    else pending.push(...node.namedChildren.filter((child): child is Node => child !== null).toReversed());
  }
  return found;
}

/** Execute the AST's state transfers once per reachable path. Effects are
 * inspected by the caller, and process-local scopes never change the parent. */
export async function walkShellFlow(root: Node, initial: ShellState, transfers: ShellTransfers, depth: number): Promise<ShellFlow> {
  const sequence = async (nodes: readonly Node[], state: ShellState): Promise<ShellFlow> => {
    let flow = shellFlow(state);
    for (const node of nodes) flow = await walk(node, joinShellFlow(flow));
    return flow;
  };
  /** An AND/OR list whose last command carries `redirects`. Lists nest to the
   * left, so the last command is always the right operand. */
  const list = async (node: Node, state: ShellState, redirects: readonly Node[]): Promise<ShellFlow> => {
    const children = node.namedChildren.filter((child): child is Node => child !== null);
    const first = children[0];
    const second = children[1];
    if (!first || !second) return sequence([...redirects, ...children], state);
    const left = await walk(first, state);
    const and = node.children.some(child => child?.type === "&&");
    const start = joinShellFlow(await sequence(redirects, (and ? left.success : left.failure).copy()));
    const right = await walk(second, start);
    const merged = (and ? left.failure : left.success).copy();
    merged.merge([and ? left.failure : left.success, and ? right.failure : right.success]);
    return and ? { success: right.success, failure: merged } : { success: merged, failure: right.failure };
  };
  const walk = async (node: Node, state: ShellState): Promise<ShellFlow> => {
    transfers.spend();
    const children = node.namedChildren.filter((child): child is Node => child !== null);
    if (node.type === "comment") return shellFlow(state);
    if (node.type === "heredoc_redirect") {
      const body = children.filter(child => child.type === "heredoc_body");
      const expanded = await sequence(body, state);
      return sequence(children.filter(child => child.type !== "heredoc_body"), joinShellFlow(expanded));
    }
    if (node.type === "redirected_statement") {
      const body = node.childForFieldName("body");
      const redirects = children.filter(child => child.id !== body?.id);
      // The grammar binds a redirect after `a && b` to the whole list, but the
      // shell binds it to the last command, which runs after `a` changed state.
      if (body?.type === "list") return list(body, state, redirects);
      const flow = await sequence(redirects, state);
      return body ? walk(body, joinShellFlow(flow)) : flow;
    }
    if (["subshell", "command_substitution", "process_substitution", "pipeline"].includes(node.type)) {
      if (node.type === "pipeline") {
        for (const child of children) {
          const result = joinShellFlow(await walk(child, state.copy(false)));
          await transfers.finish(result, depth);
          state.absorbFilesystem(result);
        }
      } else {
        const result = joinShellFlow(await sequence(children, state.copy(false)));
        await transfers.finish(result, depth);
        state.absorbFilesystem(result);
      }
      return shellFlow(state);
    }
    if (node.type === "list") return list(node, state, []);
    if (node.type === "if_statement") {
      const exits: ShellState[] = [];
      let untaken = state;
      const clauses = [node, ...children.filter(child => child.type === "elif_clause")];
      for (const clause of clauses) {
        const then = clause.children.find(child => child?.type === "then");
        const statements = clause.namedChildren.filter((child): child is Node => child !== null && !["elif_clause", "else_clause"].includes(child.type));
        const condition = await sequence(statements.filter(child => then && child.endIndex <= then.startIndex), untaken);
        exits.push(joinShellFlow(await sequence(statements.filter(child => then && child.startIndex > then.startIndex), condition.success.copy())));
        untaken = condition.failure.copy();
      }
      const otherwise = children.find(child => child.type === "else_clause");
      exits.push(otherwise ? joinShellFlow(await walk(otherwise, untaken)) : untaken);
      const merged = state.copy();
      merged.merge(exits);
      return shellFlow(merged);
    }
    if (node.type === "case_statement") {
      const exits = [state.copy()];
      for (const child of children) {
        const branch = joinShellFlow(await walk(child, state.copy()));
        if (child.type === "case_item") exits.push(branch);
      }
      const merged = state.copy();
      merged.merge(exits);
      return shellFlow(merged);
    }
    if (node.type === "for_statement") {
      const variable = node.childForFieldName("variable")?.text;
      const body = node.childForFieldName("body");
      const values = node.childrenForFieldName("value").filter((value): value is Node => value !== null);
      for (const value of values) for (const substitution of shellSubstitutions(value)) state.absorbFilesystem(joinShellFlow(await walk(substitution, state.copy())));
      if (variable && body && values.length) {
        const words = values.flatMap<ExpandedWord | null>(value => expandShellFields(value.text, key => state.lookup(key), transfers.dialect, state.changedIFS) ?? [null]);
        if (words.every(word => word !== null && word.wildcard === undefined)) {
          let current = state;
          for (const word of words) {
            current.setVariable(variable, word?.value ?? null);
            current = joinShellFlow(await walk(body, current));
          }
          return shellFlow(current);
        }
      }
    }
    if (["while_statement", "for_statement", "c_style_for_statement"].includes(node.type)) {
      const entry = state.copy();
      let current = state.copy();
      const variable = node.childForFieldName("variable")?.text;
      const statements = node.type === "for_statement" ? children.filter(child => child.type === "do_group") : children;
      for (let iteration = 0; iteration < 8; iteration++) {
        const before = current.copy();
        if (variable) current.setVariable(variable, null);
        const after = joinShellFlow(await sequence(statements, current));
        current = before.copy();
        current.merge([entry, after]);
        if (current.same(before)) return shellFlow(current);
      }
      throw new Error("shell loop state budget exhausted");
    }
    if (node.type === "variable_assignment") {
      for (const substitution of shellSubstitutions(node)) state.absorbFilesystem(joinShellFlow(await walk(substitution, state.copy())));
      state.assign(node.text, transfers.dialect);
      return shellFlow(state);
    }
    if (node.type === "command" || node.type === "unset_command") return transfers.command(node, children, state, depth);
    if (node.type === "file_redirect") transfers.redirect(node, state);
    return sequence(children, state);
  };
  return walk(root, initial);
}
