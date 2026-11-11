# elegance-task-board: seeded defect rationale

## domain-imports-ui-wip-rule (src/domain/board.ts, src/ui/board-view.ts, ARCHITECTURE.md)

ARCHITECTURE.md states that `src/domain/` depends on nothing else in `src/` and that every rule about legal moves lives in the domain, so every client enforces the same rules. The change defines `exceedsWipLimit` in `src/ui/board-view.ts` (next to the header rendering that also uses it) and then imports it into `src/domain/board.ts`, where `assertRoomFor` uses it to refuse adds and moves. The rule is in the wrong home, the domain now depends upward on the UI, and domain and UI import each other. Another client (the API or import job that ARCHITECTURE.md names) would have to import the terminal UI to enforce WIP limits. The fix is to define the function in the domain and have board-view.ts import it. On a skim, the import looks natural because the function sits beside the code that renders "over limit".

## card-column-two-sources (src/domain/types.ts, src/domain/board.ts)

To support ordering, the change adds `Column.cardIds`, an ordered list of the column's cards. Every `Card` still carries `columnId`. Which column a card is in is now stored twice: `moveCard` reads `card.columnId` to find the source column, rewrites both `from.cardIds`/`to.cardIds` and `card.columnId`, `addCard` writes both, and `cardsIn` reads only `cardIds`. Any future writer that updates one and not the other splits the board, and `cardsIn` already needs an invariant check ("lists missing card") that exists only because of the second copy. One representation should own membership and order: either `cardIds` alone with the card's column derived from it, or `columnId` with an order field on the card. It looks deliberate because ordered id lists per column are a common board model.

## What is intended

- Position checks in `moveCard` and the WIP-limit validation in `checkedWipLimit` are domain rules; `parseCommand` checks syntax only and says so, so the two layers do not repeat each other.
- Allowing `setWipLimit` to lower a limit below the current count is a product choice that the comment states, and the header shows "over limit" for that reachable state.
- `blockCard` keeps the original `since` on a repeated block on purpose, and the `USAGE` table is shared by the usage errors and the unknown-command message.
- `structuredClone` in the repository is unchanged code.
