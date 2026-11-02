import { deslugify } from "../canonical-name.js";
import { stringField, type JsonFields } from "../output/json-field.js";
import { isRecord } from "../record.js";
import { parseWorkflowYaml } from "../workflow-yaml.js";
import { isQualifiedSkillId } from "../skill-id.js";

/** The extension of a workflow file that a chat agent launches by path. */
export const WORKFLOW_FILE_EXTENSION = ".workflow.yaml";

/** The saved workflow file that a launch starts. */
export type WorkflowLaunchSource = { readonly kind: "path"; readonly path: string };

/** What one `workflow` call names: a launch source, or the content of a
 *  workflow file. The call saves content in the session's workflow
 *  directory under {@link workflowContentFileName} and launches the saved
 *  file by its path, so a content call is a path launch of that file. */
export type WorkflowCallSource = WorkflowLaunchSource | { readonly kind: "content"; readonly content: string };

/** Past named calls stay readable. Remove the named arm after 2027-04-30. */
export type RecordedWorkflowCallSource = WorkflowCallSource | { readonly kind: "registered"; readonly definitionId: string };

/** The source that one `source` object names, or undefined when it does not
 *  name one with the field that its kind requires. Named sources cannot launch. */
export function workflowSource(value: unknown): WorkflowCallSource | undefined {
  if (!isRecord(value)) return undefined;
  const path = stringField(value, "path");
  if (value.kind === "path" && path) return { kind: "path", path };
  const content = stringField(value, "content");
  if (value.kind === "content" && content) return { kind: "content", content };
  return undefined;
}

/** The name of the file that a content call saves: the workflow's id when
 *  the content names a dot-free slug id, else `workflow`. So revised content
 *  with the same id replaces the file that it revises, and no id can name a
 *  path outside the workflow directory. Content that does not parse still
 *  has a name, because a refused launch keeps its file for the author. */
export function workflowContentFileName(content: string): string {
  let id: unknown;
  try {
    const document: unknown = parseWorkflowYaml(content);
    id = isRecord(document) ? document.id : undefined;
  } catch {
    id = undefined;
  }
  const slug = typeof id === "string" && isQualifiedSkillId(id) && !id.includes(".") ? id : "workflow";
  return `${slug}${WORKFLOW_FILE_EXTENSION}`;
}

/** The source that one recorded `workflow` call input names, or undefined
 *  when it names none that can launch. This is the one reader of recorded
 *  call input: rendering, completion reconciliation, and result correction
 *  read the source here, so a call from any build reads the same way.
 *  Recorded input retains the pre-coercion form. Live coercion accepts a
 *  JSON-string source. Decode that form without changing the recorded fact.
 *
 *  Before the `source` object, a recorded call identified a named workflow
 *  in a top-level `workflow_definition_id`. That earlier shape reads as a
 *  registered source. Remove both named forms after 2027-04-30. */
export function workflowCallSource(input: JsonFields | undefined): RecordedWorkflowCallSource | undefined {
  if (input === undefined) return undefined;
  let source: unknown = input.source;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = undefined;
    }
  }
  if (isRecord(source)) {
    const definitionId = stringField(source, "definition_id");
    if (source.kind === "registered" && definitionId) return { kind: "registered", definitionId };
    return workflowSource(source);
  }
  const earlierDefinitionId = stringField(input, "workflow_definition_id");
  return earlierDefinitionId ? { kind: "registered", definitionId: earlierDefinitionId } : undefined;
}

/** The words that name a source when no display name was recorded: the
 *  registered id, or the base name of the file without its extension. A
 *  content source names the file that its call saves. */
export function workflowSourceLabel(source: RecordedWorkflowCallSource): string {
  if (source.kind === "registered") return deslugify(source.definitionId);
  const path = source.kind === "path" ? source.path : workflowContentFileName(source.content);
  const base = path.split(/[\\/]/u).at(-1) ?? path;
  return deslugify(base.endsWith(WORKFLOW_FILE_EXTENSION) ? base.slice(0, -WORKFLOW_FILE_EXTENSION.length) : base);
}

/** Whether one recorded call launched the workflow child that records this
 *  definition id and request. A registered call names the id. A path or
 *  content call names its file, and only the launch read the id that the
 *  file declares, so the tool-use binding of the child pairs the two and
 *  only the request is compared. */
export function workflowCallLaunched(
  input: JsonFields | undefined,
  child: { readonly workflowDefinitionId: string; readonly description: string },
): boolean {
  const source = workflowCallSource(input);
  if (source === undefined || input?.description !== child.description) return false;
  return source.kind !== "registered" || source.definitionId === child.workflowDefinitionId;
}
