import type { QuickPick, QuickPickItem } from "vscode"

import { mentionPath } from "../../../src/protocol/client/mention.js"
import type { ProjectFileEntry } from "../../../src/protocol/transcript-protocol-types.js"

/** The project file picker. The files come from the runtime, which lists and
 *  ranks them for the client's `@` panel too: there is one list of a
 *  project's files, and it never offers Flywheel's own state or a file the
 *  project ignores. The quick pick is passed in, so this module needs no
 *  extension host to run. */

/** The part of a VS Code quick pick the file picker uses. */
export type FileQuickPick = Pick<QuickPick<FileItem>, "title" | "placeholder" | "busy" | "value" | "items" | "activeItems" | "selectedItems" | "onDidChangeValue" | "onDidAccept" | "onDidHide" | "show" | "hide" | "dispose">

export interface FileItem extends QuickPickItem {
  readonly entry: ProjectFileEntry
}

/** Asks for one project file and returns it as a mention: quoted when its
 *  path holds a space and followed by a space, the way the client's own
 *  picker inserts it. Enter takes the highlighted row. A directory opens in
 *  place, so a person walks into it the way the `@` panel does. Resolves
 *  undefined when the person closes the picker. */
export function pickFile(
  listFiles: (query: string) => Promise<readonly ProjectFileEntry[]>,
  createQuickPick: () => FileQuickPick,
): Promise<string | undefined> {
  const pick = createQuickPick()
  pick.title = "Mention a project file"
  pick.placeholder = "Type part of a path. Flywheel reads the file itself."
  let search = 0
  const list = (query: string): void => {
    const mine = ++search
    pick.busy = true
    listFiles(query).then((entries) => {
      if (mine !== search) return
      pick.busy = false
      pick.items = entries.map((entry) => ({
        label: `$(${entry.directory ? "folder" : "file"}) ${entry.path}${entry.directory ? "/" : ""}`,
        entry,
        // The runtime already matched and ranked every row against the
        // query, so the quick pick must not filter them a second time.
        alwaysShow: true,
      }))
    }, (cause: unknown) => {
      if (mine !== search) return
      pick.busy = false
      pick.items = []
      pick.placeholder = `Flywheel could not list the project's files: ${cause instanceof Error ? cause.message : String(cause)}`
    })
  }
  return new Promise((resolve) => {
    pick.onDidChangeValue(list)
    pick.onDidAccept(() => {
      const entry = pick.selectedItems[0]?.entry ?? pick.activeItems[0]?.entry
      if (entry === undefined) return
      if (entry.directory) {
        pick.value = `${entry.path}/`
        list(pick.value)
        return
      }
      resolve(`@${mentionPath(entry.path)} `)
      pick.hide()
    })
    pick.onDidHide(() => {
      resolve(undefined)
      pick.dispose()
    })
    list("")
    pick.show()
  })
}
