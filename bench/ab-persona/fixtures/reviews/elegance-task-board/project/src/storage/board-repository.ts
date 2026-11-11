import type { Board } from "../domain/types.ts";

/** Boards kept in memory for the single-process demo server. Copies go in and
 *  out, so a caller that mutates a loaded board must save it to publish. */
export class InMemoryBoardRepository {
  private readonly boards = new Map<string, Board>();

  load(boardId: string): Board {
    const board = this.boards.get(boardId);
    if (board === undefined) throw new Error(`Unknown board ${boardId}`);
    return structuredClone(board);
  }

  save(board: Board): void {
    this.boards.set(board.id, structuredClone(board));
  }
}
