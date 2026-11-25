import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { openContainedDirectory } from "../../../../infra/descriptor-directory.js"
import { DebugLog } from "../../../../infra/diagnostics/debug-log.js"
import { errnoCode, errorMessage } from "../../../../infra/error-message.js"
import { sessionScratchDir } from "../../../../infra/paths.js"
import { WORKFLOW_FILE_EXTENSION, workflowContentFileName, type WorkflowCallSource } from "../../../../infra/tools/workflow-call-source.js"
import { WORKFLOW_FILE_MAX_BYTES } from "../../../../infra/yaml/workflow-yaml.js"
import { resolveToolPath } from "../files/tool-paths.js"

/** The one directory a session's workflow files launch from. */
export function sessionWorkflowsDir(sessionDir: string): string {
  return join(sessionScratchDir(sessionDir), "workflows")
}

/** Save the content of a workflow file that a `workflow` call or an
 *  approval question passes, and answer the file's absolute path. The file
 *  is `<id>.workflow.yaml` in the workflow directory (refer to
 *  `workflowContentFileName`) and replaces a file of that name, so an
 *  author revises a workflow by sending it again. A run never reads its
 *  file again, so a replaced file never changes a run that started. The
 *  content over the byte limit is refused before parsing or writing. Other launch
 *  checks follow the save, so a refused launch keeps the file for the
 *  author to fix. The write is atomic and follows no directory link. */
function saveWorkflowContent(sessionDir: string, content: string): string {
  const bytes = Buffer.byteLength(content)
  if (bytes > WORKFLOW_FILE_MAX_BYTES) throw new Error(`the workflow content holds ${bytes} bytes, more than the limit of ${WORKFLOW_FILE_MAX_BYTES}`)
  const name = workflowContentFileName(content)
  const directory = openContainedDirectory(sessionDir, relative(sessionDir, sessionWorkflowsDir(sessionDir)).split(sep), { noFollowBase: true })
  try {
    const file = join(directory.canonicalPath(), name)
    const replaced = directory.hasEntry(name)
    const failure = directory.publishFileThrough(`.workflow-write.${process.pid}.${randomBytes(6).toString("hex")}`, name, content)
    if (failure) throw failure
    DebugLog.record({
      type: "workflow.file.saved",
      payload: { file, bytes, sha256: createHash("sha256").update(content).digest("hex"), replaced },
    })
    return file
  } finally {
    directory.close()
  }
}

/** The file that one `workflow` call launches, and the bytes it judges. */
export interface StagedWorkflowFile {
  /** The absolute path of the file in the session's workflow directory. */
  readonly path: string
  /** Bytes the call saved there; absent when the call names a file that was already there. */
  readonly savedContent?: string
  /** The file that a path call named outside the workflow directory, whose bytes the call saved. */
  readonly copiedFrom?: string
}

/** Place what one `workflow` call names in the session's workflow
 *  directory, so every file that runs is a file there. Content is saved as
 *  its own file. A path resolves as a file tool resolves it: an absolute
 *  path as written, and a relative path from the agent's working directory,
 *  then from the session directory, where `scratch/workflows/<name>` names a
 *  saved file. A file inside the workflow directory launches as it is. A
 *  file anywhere else, such as one in the project, is read once and saved
 *  as content, so a file can launch from any path; a later edit of the
 *  original never changes the run. */
export function stageWorkflowSource(source: WorkflowCallSource, sessionDir: string, executionCwd: string): StagedWorkflowFile | { readonly error: string } {
  if (source.kind === "content") return { path: saveWorkflowContent(sessionDir, source.content), savedContent: source.content }
  const fromCwd = isAbsolute(source.path) ? resolve(source.path) : resolveToolPath(executionCwd, source.path)
  const named = isAbsolute(source.path) || existsSync(fromCwd) ? fromCwd : resolve(sessionDir, source.path)
  if (inside(sessionWorkflowsDir(sessionDir), named)) return { path: named }
  if (!named.endsWith(WORKFLOW_FILE_EXTENSION)) return { error: `The workflow file ${named} cannot launch: its name must end in ${WORKFLOW_FILE_EXTENSION}.` }
  let content: string
  try {
    const stat = statSync(named)
    if (!stat.isFile()) return { error: `The workflow file ${named} cannot launch: it is not a file.` }
    if (stat.size > WORKFLOW_FILE_MAX_BYTES) return { error: `The workflow file ${named} cannot launch: it holds more than the limit of ${WORKFLOW_FILE_MAX_BYTES} bytes.` }
    content = readFileSync(named, "utf8")
  } catch (error) {
    return { error: errnoCode(error) === "ENOENT" ? `No workflow file exists at ${named}.` : `The workflow file ${named} cannot be read: ${errorMessage(error)}` }
  }
  return { path: saveWorkflowContent(sessionDir, content), savedContent: content, copiedFrom: named }
}

/** Whether `candidate` is below `root`. */
export function inside(root: string, candidate: string): boolean {
  const rest = relative(root, candidate)
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}
