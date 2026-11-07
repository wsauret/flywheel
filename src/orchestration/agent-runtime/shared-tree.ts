import type { FirstPartyModuleComposition } from "../modules.js";

/**
 * What every agent of one chat tree shares while the tree's shared agent host can serve it (ARCH-PROVIDERS-006, ARCH-PROVIDERS-031,
 * ARCH-RUNTIME-068). The host's launch fixes the tool list byte for byte, so every agent of the tree plans its tools
 * from one capture of what decides those bytes (`SharedTreeCapture`). A module turned off later narrows only what an
 * agent may call, and a changed shell write guard changes the shell's description when the tree is captured again,
 * while every agent's shell enforces the current guard at once. Each request of the
 * tree prefers the login of the tree's live host among logins whose included quota expires at the same moment, so the
 * tree leaves that login only for a sooner expiring reset or when the login cannot serve.
 */
export interface SharedTree extends SharedTreeCapture {
  readonly treeRootSessionId: string;
  /** The account key (`accessProviderAccountKey`) of the login that the tree's newest live host uses. */
  readonly login: string | undefined;
  /** Keeps the tree while the holder lives, and names `login` as the tree's login while it holds. Returns the
   *  release, which takes effect once. */
  hold(login?: string): () => void;
}

/** What the tree's first holder captured: every input that changes the tool bytes of the tree's host. */
export interface SharedTreeCapture {
  readonly modules: FirstPartyModuleComposition;
  /** Whether the shell's description states the write roots of `shell_write_guard`. The tree keeps one value for all
   *  its agents so that their shell bytes match (ARCH-CONTEXT-018); the shell enforces the current setting
   *  (PI-AGENT-068). */
  readonly shellWriteGuard: boolean;
}

/** One holder's use of its chat tree's shared state. */
export interface SharedTreeHold {
  readonly tree: SharedTree;
  /** Ends the use. Takes effect once. */
  readonly release: () => void;
}

const trees = new Map<string, SharedTree>();

/** The login of the live shared host of the chat tree rooted at `treeRootSessionId`, read without holding the tree, so
 *  the tree's chat, which keeps its own engine, prefers that login too. */
export function treeLogin(treeRootSessionId: string): string | undefined {
  return trees.get(treeRootSessionId)?.login;
}

/**
 * Holds the shared state of the chat tree rooted at `treeRootSessionId`. The first holder creates it with what
 * `capture` returns; later holders get that capture, whatever the selection and the configuration are now. The state is
 * removed when its last holder releases it, so the next holder captures again.
 */
export function holdSharedTree(treeRootSessionId: string, capture: () => SharedTreeCapture): SharedTreeHold {
  let tree = trees.get(treeRootSessionId);
  if (tree === undefined) {
    let holders = 0;
    // The logins of the live holders that name one, from the oldest.
    const logins: { readonly login: string }[] = [];
    const created: SharedTree = {
      ...capture(),
      treeRootSessionId,
      get login() { return logins.at(-1)?.login; },
      hold(login) {
        holders += 1;
        const named = login === undefined ? undefined : { login };
        if (named !== undefined) logins.push(named);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          holders -= 1;
          if (named !== undefined) logins.splice(logins.indexOf(named), 1);
          if (holders === 0 && trees.get(treeRootSessionId) === created) trees.delete(treeRootSessionId);
        };
      },
    };
    trees.set(treeRootSessionId, created);
    tree = created;
  }
  return { tree, release: tree.hold() };
}
