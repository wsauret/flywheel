import type { BuiltInCommandDescriptor } from "../command-catalog-protocol-types.js"

/** The published commands in command-menu order: the `top`, `chat`, and
 *  `more` groups, each by ascending rank, then every command without a
 *  position in publication order (ARCH-PROTOCOL-037). A client renders these
 *  groups and names no command itself. */
export function commandMenuGroups(commands: readonly BuiltInCommandDescriptor[]) {
  const group = (name: "top" | "chat" | "more") => commands.filter((command) => command.menu?.group === name).toSorted((a, b) => (a.menu?.rank ?? 0) - (b.menu?.rank ?? 0))
  return { top: group("top"), chat: group("chat"), more: group("more"), rest: commands.filter((command) => command.menu === undefined) }
}

/** Use counts per command, under each command's own token. The usage record
 *  keeps the token a person typed, so the uses of an alias count toward the
 *  command it names; a token no command in `commands` claims keeps its own
 *  count. One entry is one menu row, whichever token reached it. */
export function usesPerCommand(uses: Iterable<readonly [token: string, count: number]>, commands: readonly { readonly id: string; readonly aliases: readonly string[] }[]): ReadonlyMap<string, number> {
  const owner = new Map(commands.flatMap((command) => command.aliases.map((alias) => [alias, command.id] as const)))
  const counts = new Map<string, number>()
  for (const [token, count] of uses) {
    const id = owner.get(token) ?? token
    counts.set(id, (counts.get(id) ?? 0) + count)
  }
  return counts
}
