import type { ContainedFileMetadata } from "../../../infra/descriptor-directory.js";
import type { LineRange } from "./file-read-ledger.js";
import { type PatchPlan, planPreparedPatch } from "../../../infra/file-edit/patch-plan.js";
import { type PreparedOperation, type PreparedPatch, preparePatch } from "../../../infra/file-edit/patch-parser.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import type { AdmittedFileEdit, PlannedFileEdit } from "../../file-edits/file-edit-operation.js";
import { boundedMutationReport, publishToolFileEdits } from "./file-edit-tool-adapter.js";
import { lineRangeOfByteSpans } from "./file-read-ledger.js";
import { MAX_FILE_EDIT_BYTES, RetainedFileEditAuthority } from "../../file-edits/retained-file-edit-host.js";
import { resolveToolPath, sessionPathInput } from "./tool-paths.js";
import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "./types.js";

/** The Codex V4A envelope, in the Lark form OpenAI custom tools constrain generation with. */
const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " " ) /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

interface VirtualPatchFile {
  readonly content: string;
  readonly metadata?: ContainedFileMetadata;
}

interface PublicationDependency {
  readonly predecessor: string;
  readonly successor: string;
}

const APPLY_PATCH_SCHEMA = {
  type: "object",
  properties: {
    input: { type: "string", description: "The complete apply_patch envelope, from *** Begin Patch through *** End Patch" },
  },
  required: ["input"],
  additionalProperties: false,
} as const;

function patchText(input: Readonly<RuntimeToolInput>): string | undefined {
  return typeof input.input === "string" ? input.input : undefined;
}
/** Admission parses the patch once; execution reads that plan back by the identity of the admitted input. */
const preparedPatches = new WeakMap<Readonly<RuntimeToolInput>, PreparedPatch>();

/** The envelope, shown whole. A model that sees the grammar alone declares the
 *  tool unavailable rather than guess at the syntax; the same model calls it
 *  at once when the prompt carries one worked example. */
const APPLY_PATCH_PROMPT_EXAMPLES = `The whole input is one patch envelope. Each file is one hunk: Add File with every line prefixed by +, Delete File alone, or Update File with an optional Move to and one or more changes. A change starts at @@ (optionally followed by a nearby line for context), keeps unchanged lines prefixed by a space, removes lines with - and adds lines with +.

*** Begin Patch
*** Update File: src/example.py
@@ def example():
-    pass
+    return 123
*** Add File: docs/note.txt
+first line
+second line
*** Delete File: old/stale.txt
*** End Patch`;

/** Builds the patch tool; scoped callers validate and resolve parsed targets before admission. */
export function createApplyPatchDefinition(resolveTargets?: (patch: PreparedPatch, executionCwd: string) => PreparedPatch): RuntimeTool {
  return {
    name: "apply_patch",
    action: "file_edit",
    description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON. The result carries the diff hunks that landed; do not re-read a file after a successful patch.",
    promptGuidelines: [
      "Apply a patch through this tool; never run `applypatch` or `apply-patch` in the shell.",
      "Do not re-read files after a successful apply_patch; the call fails loudly when it did not apply.",
    ],
    promptExamples: APPLY_PATCH_PROMPT_EXAMPLES,
    inputSchema: APPLY_PATCH_SCHEMA,
    // The description above is the upstream FREEFORM text, true only on the custom wire. A route that sends the
    // tool as a JSON function sends this description instead. The system-prompt snippet and example stay
    // wire-neutral, because one request's failover chain can mix both wires.
    wire: {
      kind: "custom",
      grammar: { syntax: "lark", definition: APPLY_PATCH_LARK_GRAMMAR },
      functionDescription: "The `apply_patch` tool can be used to edit files. Put the whole patch envelope, from *** Begin Patch through *** End Patch, in the `input` string. The result carries the diff hunks that landed; do not re-read a file after a successful patch.",
    },
    validatesOwnInput: true,
    isConcurrencySafe: false,
    prepareAdmission: async (input, context) => {
      const { executionCwd } = context;
      const patch = patchText(input);
      if (patch === undefined) throw new Error("apply_patch expects a patch string");
      const parsed = preparePatch(patch);
      const preparedPatch = resolveTargets ? resolveTargets(parsed, executionCwd) : parsed;
      const notices: string[] = [];
      if (parsed.ignoredEmptyHunks) notices.push(`Note: ignored ${parsed.ignoredEmptyHunks} empty update hunk(s).`);
      if (parsed.ignoredEmptyUpdates?.length) notices.push(`Note: ignored empty update sections: ${parsed.ignoredEmptyUpdates.join(", ")}.`);
      for (const path of preparedPatch.paths) {
        if (!path.startsWith("~")) continue;
        const expanded = sessionPathInput({ path }, context, "new-file");
        if (expanded.repair) notices.push(expanded.repair.notice);
      }
      const normalized = notices.length === 0 ? input : { ...input };
      preparedPatches.set(normalized, preparedPatch);
      return {
        reservedPaths: preparedPatch.paths.map(path => canonicalMutationPath(resolveToolPath(executionCwd, path))),
        ...(notices.length === 0 ? {} : { repair: { input: normalized, notice: notices.join("\n") } }),
      };
    },
    async execute(input: RuntimeToolInput, context: ToolContext): Promise<ToolResult> {
      const preparedPatch = preparedPatches.get(input);
      if (preparedPatch === undefined) return { content: "apply_patch was not prepared for execution", outcome: "error" };
      if (preparedPatch.operations.length === 0) return { content: "Note: patch contains no changes.", outcome: "ok" };
      let admittedSnapshotBytes = 0;
      let unchanged: readonly string[] = [];
      const result = await publishToolFileEdits(context, {
        label: "Patch",
        paths: preparedPatch.paths,
        admit: resolvedPath => {
          const authority = RetainedFileEditAuthority.admitWritable(resolvedPath);
          if (authority.snapshot && authority.text === undefined) {
            authority.close();
            throw new Error(`${resolvedPath} is not valid UTF-8`);
          }
          const snapshotBytes = authority.snapshot?.content.byteLength ?? 0;
          if (snapshotBytes > MAX_FILE_EDIT_BYTES - admittedSnapshotBytes) {
            authority.close();
            throw new Error(`patch target snapshots exceed the ${MAX_FILE_EDIT_BYTES}-byte operation limit`);
          }
          admittedSnapshotBytes += snapshotBytes;
          return authority;
        },
        plan: admitted => {
          rejectAliasedTargets(admitted);
          const byAuthoredPath = new Map(admitted.map(entry => [entry.path, entry] as const));
          const plans = planPreparedPatch(preparedPatch, admitted.map(entry => ({ path: entry.path, content: entry.authority.text })));
          const publications = compilePlans(preparedPatch.operations, plans, byAuthoredPath);
          const changed = new Set(publications.map(publication => publication.admitted.path));
          unchanged = admitted.filter(entry => !changed.has(entry.path)).map(entry => entry.path);
          return publications;
        },
      });
      return unchanged.length === 0 ? result : {
        ...result,
        content: boundedMutationReport(`Note: unchanged files: ${unchanged.join(", ")}.\n${result.content}`.trimEnd()),
      };
    },
  };
}

function requiredAdmission(paths: ReadonlyMap<string, AdmittedFileEdit>, path: string): AdmittedFileEdit {
  const admitted = paths.get(path);
  if (!admitted) throw new Error(`Patch plan introduced an unadmitted path: ${path}`);
  return admitted;
}

function rejectAliasedTargets(admitted: readonly AdmittedFileEdit[]): void {
  const canonical = new Set<string>();
  const identities = new Set<string>();
  for (const entry of admitted) {
    if (canonical.has(entry.authority.canonicalPath)) throw new Error(`Patch contains duplicate physical target: ${entry.path}`);
    canonical.add(entry.authority.canonicalPath);
    const identity = entry.authority.snapshot?.identity;
    if (identity && identities.has(identity)) throw new Error(`Patch contains paths to the same file object: ${entry.path}`);
    if (identity) identities.add(identity);
  }
}

/** Replays the planned operations over virtual file states so one patch that touches a path several times
 *  publishes each path once, in first-effect order, with move destinations published before their sources
 *  are deleted. */
function compilePlans(
  operations: readonly PreparedOperation[],
  plans: readonly PatchPlan[],
  admitted: ReadonlyMap<string, AdmittedFileEdit>,
): readonly PlannedFileEdit[] {
  if (plans.length !== operations.length) throw new Error("Patch planner returned an invalid operation count");
  const initial = initialVirtualFiles(admitted);
  const current = new Map(initial);
  const effectOrder = new Map<string, number>();
  const dependencies: PublicationDependency[] = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const operation = operations[index];
    if (!plan || !operation || plan.kind !== operation.kind || plan.path !== operation.path) throw new Error("Patch planner changed the prepared operation order");
    applyPlan(operation, plan, admitted, current, effectOrder, dependencies);
  }
  return compilePublications(admitted, initial, current, effectOrder, dependencies, changedLinesByPath(plans, initial));
}

/** Lines each source file's update chunks replaced, for partial-read warnings. */
function changedLinesByPath(plans: readonly PatchPlan[], initial: ReadonlyMap<string, VirtualPatchFile | undefined>): ReadonlyMap<string, LineRange> {
  const spansByPath = new Map<string, { start: number; end: number }[]>();
  for (const plan of plans) {
    if (plan.kind !== "update") continue;
    spansByPath.set(plan.path, [...(spansByPath.get(plan.path) ?? []), ...plan.spans]);
  }
  const changed = new Map<string, LineRange>();
  for (const [path, spans] of spansByPath) {
    const before = initial.get(path)?.content;
    const range = before === undefined ? undefined : lineRangeOfByteSpans(Buffer.from(before, "utf8"), spans);
    if (range) changed.set(path, range);
  }
  return changed;
}

function initialVirtualFiles(admitted: ReadonlyMap<string, AdmittedFileEdit>): Map<string, VirtualPatchFile | undefined> {
  const files = new Map<string, VirtualPatchFile | undefined>();
  for (const [path, entry] of admitted) {
    const text = entry.authority.text;
    const metadata = entry.authority.snapshot?.metadata;
    files.set(path, text === undefined ? undefined : virtualFile(text, metadata));
  }
  return files;
}

function applyPlan(
  operation: PreparedOperation,
  plan: PatchPlan,
  admitted: ReadonlyMap<string, AdmittedFileEdit>,
  current: Map<string, VirtualPatchFile | undefined>,
  effectOrder: Map<string, number>,
  dependencies: PublicationDependency[],
): void {
  const source = requiredAdmission(admitted, plan.path);
  const sourceState = current.get(plan.path);
  if (plan.kind === "add") {
    if (plan.overwrittenContent !== sourceState?.content) throw new Error(`Patch planner mismatched admitted content: ${plan.path}`);
    if (plan.newContent === sourceState?.content) return;
    source.authority.encode(plan.newContent);
    recordEffect(effectOrder, plan.path);
    current.set(plan.path, virtualFile(plan.newContent, sourceState?.metadata ?? source.authority.defaultPublicationMetadata()));
    return;
  }
  if (!sourceState || plan.oldContent !== sourceState.content) throw new Error(`Patch planner mismatched admitted content: ${plan.path}`);
  if (plan.kind === "delete") {
    recordEffect(effectOrder, plan.path);
    current.set(plan.path, undefined);
    return;
  }
  if (operation.kind !== "update" || plan.movePath !== operation.movePath) throw new Error(`Patch planner changed the move destination: ${plan.path}`);
  applyUpdatePlan(plan, sourceState, admitted, current, effectOrder, dependencies);
}

function applyUpdatePlan(
  plan: Extract<PatchPlan, { readonly kind: "update" }>,
  sourceState: VirtualPatchFile,
  admitted: ReadonlyMap<string, AdmittedFileEdit>,
  current: Map<string, VirtualPatchFile | undefined>,
  effectOrder: Map<string, number>,
  dependencies: PublicationDependency[],
): void {
  if (plan.movePath === undefined || plan.movePath === plan.path) {
    if (plan.newContent === sourceState.content) return;
    const source = requiredAdmission(admitted, plan.path);
    source.authority.encode(plan.newContent);
    recordEffect(effectOrder, plan.path);
    current.set(plan.path, virtualFile(plan.newContent, sourceState.metadata));
    return;
  }
  const destination = requiredAdmission(admitted, plan.movePath);
  const destinationState = current.get(plan.movePath);
  if (plan.overwrittenContent !== destinationState?.content) throw new Error(`Patch planner mismatched admitted content: ${plan.movePath}`);
  destination.authority.encode(plan.newContent);
  recordEffect(effectOrder, plan.movePath);
  recordEffect(effectOrder, plan.path);
  dependencies.push({ predecessor: plan.movePath, successor: plan.path });
  current.set(plan.movePath, virtualFile(plan.newContent, sourceState.metadata));
  current.set(plan.path, undefined);
}

function virtualFile(content: string, metadata: ContainedFileMetadata | undefined): VirtualPatchFile {
  return metadata === undefined ? { content } : { content, metadata };
}

function recordEffect(effectOrder: Map<string, number>, path: string): void {
  if (!effectOrder.has(path)) effectOrder.set(path, effectOrder.size);
}

function compilePublications(
  admitted: ReadonlyMap<string, AdmittedFileEdit>,
  initial: ReadonlyMap<string, VirtualPatchFile | undefined>,
  current: ReadonlyMap<string, VirtualPatchFile | undefined>,
  effectOrder: ReadonlyMap<string, number>,
  dependencies: readonly PublicationDependency[],
  changedLines: ReadonlyMap<string, LineRange>,
): readonly PlannedFileEdit[] {
  const publications: PlannedFileEdit[] = [];
  for (const path of effectOrder.keys()) {
    const before = initial.get(path);
    const after = current.get(path);
    if (sameVirtualFile(before, after)) continue;
    const entry = requiredAdmission(admitted, path);
    const lines = changedLines.get(path);
    publications.push(after === undefined
      ? { admitted: entry, after: undefined }
      : {
          admitted: entry,
          after: after.content,
          ...(after.metadata === undefined ? {} : { metadata: after.metadata }),
          ...(lines === undefined ? {} : { changedLines: lines }),
        });
  }
  return orderPublications(publications, dependencies, effectOrder);
}

function orderPublications(
  publications: readonly PlannedFileEdit[],
  dependencies: readonly PublicationDependency[],
  effectOrder: ReadonlyMap<string, number>,
): readonly PlannedFileEdit[] {
  const byPath = new Map(publications.map(publication => [publication.admitted.path, publication] as const));
  const successors = new Map<string, Set<string>>();
  const indegree = new Map<string, number>(publications.map(publication => [publication.admitted.path, 0] as const));
  for (const dependency of dependencies) {
    const successor = byPath.get(dependency.successor);
    if (!byPath.has(dependency.predecessor) || successor?.after !== undefined) continue;
    const followers = successors.get(dependency.predecessor) ?? new Set<string>();
    if (followers.has(dependency.successor)) continue;
    followers.add(dependency.successor);
    successors.set(dependency.predecessor, followers);
    indegree.set(dependency.successor, (indegree.get(dependency.successor) ?? 0) + 1);
  }
  return stableTopologicalPublications(byPath, successors, indegree, effectOrder);
}

function stableTopologicalPublications(
  byPath: ReadonlyMap<string, PlannedFileEdit>,
  successors: ReadonlyMap<string, ReadonlySet<string>>,
  indegree: Map<string, number>,
  effectOrder: ReadonlyMap<string, number>,
): readonly PlannedFileEdit[] {
  const remaining = new Set(byPath.keys());
  const ordered: PlannedFileEdit[] = [];
  while (remaining.size > 0) {
    const path = nextReadyPath(remaining, indegree, effectOrder);
    if (path === undefined) throw new Error("Patch move dependencies are cyclic");
    remaining.delete(path);
    const publication = byPath.get(path);
    if (!publication) throw new Error(`Patch publication alignment failed: ${path}`);
    ordered.push(publication);
    for (const successor of successors.get(path) ?? []) {
      indegree.set(successor, (indegree.get(successor) ?? 0) - 1);
    }
  }
  return ordered;
}

function nextReadyPath(
  remaining: ReadonlySet<string>,
  indegree: ReadonlyMap<string, number>,
  effectOrder: ReadonlyMap<string, number>,
): string | undefined {
  let selected: string | undefined;
  let selectedOrder = Number.POSITIVE_INFINITY;
  for (const path of remaining) {
    const order = effectOrder.get(path);
    if ((indegree.get(path) ?? 0) !== 0 || order === undefined || order >= selectedOrder) continue;
    selected = path;
    selectedOrder = order;
  }
  return selected;
}

function sameVirtualFile(left: VirtualPatchFile | undefined, right: VirtualPatchFile | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.content === right.content
    && left.metadata === right.metadata);
}

export const applyPatchDefinition = createApplyPatchDefinition();
