import type { FirstPartyModuleComposition } from "../modules.js";

/**
 * What every agent of one chat tree shares while the tree's shared agent host can serve it (ARCH-PROVIDERS-006, ARCH-PROVIDERS-031,
 * ARCH-RUNTIME-068). The host's launch fixes the tool list byte for byte, so every agent of the tree plans its tools
 * from one module capture, and a module turned off later narrows only what an agent may call. Each request of the
 * tree prefers the login of the tree's live host among logins whose included quota expires at the same moment, so the
 * tree leaves that login only for a sooner expiring reset or when the login cannot serve.
 */
export interface SharedTree {
  readonly treeRootSessionId: string;
  /** The module selection that the tree's first holder captured. */
  readonly modules: FirstPartyModuleComposition;
  /** The account key (`accessProviderAccountKey`) of the login that the tree's newest live host uses. */
  readonly login: string | undefined;
  /** Keeps the tree while the holder lives, and names `login` as the tree's login while it holds. Returns the
   *  release, which takes effect once. */
  hold(login?: string): () => void;
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
 * Holds the shared state of the chat tree rooted at `treeRootSessionId`. The first holder creates it with the module
 * selection that `capture` returns; later holders get that capture, whatever the selection is now. The state is
 * removed when its last holder releases it, so the next holder captures again.
 */
export function holdSharedTree(treeRootSessionId: string, capture: () => FirstPartyModuleComposition): SharedTreeHold {
  let tree = trees.get(treeRootSessionId);
  if (tree === undefined) {
    let holders = 0;
    // The logins of the live holders that name one, from the oldest.
    const logins: { readonly login: string }[] = [];
    const created: SharedTree = {
      treeRootSessionId,
      modules: capture(),
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
