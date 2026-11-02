import { FileEditPlanError } from "../../../infra/file-edit/contract.js";
import type { FileSnapshot } from "../../../infra/file-edit/patch-plan.js";
import { PatchPlanningCursor } from "../../../infra/file-edit/patch-plan.js";
import type { PreparedOperation } from "../../../infra/file-edit/patch-parser.js";
import { matchStringEdit, finishStringEdit, type StringEditMatch } from "../../../infra/file-edit/string-edit.js";
import { StreamingPatch } from "../../../infra/file-edit/streaming-patch.js";
import { TopLevelJsonStringDecoder } from "../../../infra/output/partial-json.js";

export type StreamingEditValidationResult =
  | { readonly status: "clear" }
  | { readonly status: "advisory"; readonly message: string }
  | { readonly status: "unavailable" };

export type StreamingEditTool = "apply_patch" | "edit";
export type StreamingEditSnapshotReader = (path: string) => Promise<FileSnapshot>;

const CLEAR = { status: "clear" } as const;
const UNAVAILABLE = { status: "unavailable" } as const;

/**
 * Checks streamed edit input against caller-owned snapshots without retaining filesystem authority.
 * Append receives normalized JSON fragments and returns only established advice. Snapshot access
 * failures make this optional check unavailable and never refuse execution.
 */
export class StreamingEditValidator {
  private decoder?: TopLevelJsonStringDecoder;
  private patch?: StreamingPatch;
  private patchPlanner?: PatchPlanningCursor;
  private readonly snapshots = new Map<string, FileSnapshot>();
  private readonly touchedPatchPaths = new Set<string>();
  private readonly patchOperations: PreparedOperation[] = [];
  private stringContents?: string;
  private stringMatch?: StringEditMatch;
  private stringMatchStarted = false;
  private readonly completedStringFields = new Set<string>();
  private disposed = false;
  private unavailable = false;
  private advisory?: StreamingEditValidationResult & { readonly status: "advisory" };

  constructor(
    private readonly tool: StreamingEditTool,
    private readonly readSnapshot: StreamingEditSnapshotReader,
  ) {
    this.decoder = new TopLevelJsonStringDecoder(tool === "apply_patch" ? ["input"] : ["path", "old_string", "new_string", "replace_all"]);
    if (tool === "apply_patch") {
      this.patch = new StreamingPatch();
      this.patchPlanner = new PatchPlanningCursor([]);
    }
  }

  get retainedBytes(): number {
    if (this.disposed) return 0;
    let bytes = this.decoder?.acceptedBytes ?? 0;
    for (const snapshot of this.snapshots.values()) bytes += Buffer.byteLength(snapshot.path) + Buffer.byteLength(snapshot.content ?? "");
    return bytes;
  }

  async append(fragment: string): Promise<StreamingEditValidationResult> {
    if (this.disposed || this.unavailable) return UNAVAILABLE;
    if (this.advisory) return this.advisory;
    const decoder = this.decoder;
    if (!decoder) return UNAVAILABLE;
    const decoded = decoder.append(fragment);
    if (decoder.failed) return this.markUnavailable();

    try {
      return this.tool === "apply_patch"
        ? await this.appendPatch(decoded.additions.input ?? "", decoded.completedObject)
        : await this.appendString(decoded.completedFields, decoded.completedObject);
    } catch (error) {
      if (error instanceof FileEditPlanError) return this.markAdvisory(error.message);
      return this.markUnavailable();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.decoder = undefined;
    this.patch = undefined;
    this.patchPlanner = undefined;
    this.snapshots.clear();
    this.touchedPatchPaths.clear();
    this.patchOperations.length = 0;
    this.stringContents = undefined;
    this.stringMatch = undefined;
    this.advisory = undefined;
  }

  private async appendPatch(text: string, completedObject: boolean): Promise<StreamingEditValidationResult> {
    const patch = this.patch;
    if (!patch) return UNAVAILABLE;
    const progress = patch.append(text);
    for (const operation of progress.operations) await this.addPatchOperation(operation);
    if (completedObject) {
      const input = this.decoder?.field("input");
      if (typeof input !== "string") return this.markAdvisory("apply_patch expects a string input field");
      const prepared = patch.finish();
      for (const operation of prepared.operations.slice(this.patchOperations.length)) await this.addPatchOperation(operation);
    }
    return CLEAR;
  }

  private async addPatchOperation(operation: PreparedOperation): Promise<void> {
    await this.ensurePatchSnapshots(operation);
    this.patchOperations.push(operation);
    this.patchPlanner?.append(operation);
  }

  private async ensurePatchSnapshots(operation: PreparedOperation): Promise<void> {
    await this.ensureInitialSnapshot(operation.path);
    if (operation.kind === "update" && operation.movePath !== undefined) await this.ensureInitialSnapshot(operation.movePath);
    this.touchedPatchPaths.add(operation.path);
    if (operation.kind === "update" && operation.movePath !== undefined) this.touchedPatchPaths.add(operation.movePath);
  }

  private async ensureInitialSnapshot(path: string): Promise<void> {
    if (this.touchedPatchPaths.has(path) || this.snapshots.has(path)) return;
    const snapshot = await this.readSnapshot(path);
    const normalized = snapshot.path === path ? snapshot : { ...snapshot, path };
    this.snapshots.set(path, normalized);
    this.patchPlanner?.admitSnapshot(normalized);
  }

  private async appendString(completedFields: readonly string[], completedObject: boolean): Promise<StreamingEditValidationResult> {
    const decoder = this.decoder;
    if (!decoder) return UNAVAILABLE;
    for (const field of completedFields) this.completedStringFields.add(field);
    const path = decoder.field("path");
    const oldString = decoder.field("old_string");
    const pathComplete = this.completedStringFields.has("path");
    const oldComplete = this.completedStringFields.has("old_string");

    if (!this.stringMatchStarted && pathComplete && oldComplete && typeof path === "string" && typeof oldString === "string") {
      this.stringMatchStarted = true;
      const snapshot = await this.readSnapshot(path);
      this.snapshots.set(path, snapshot.path === path ? snapshot : { ...snapshot, path });
      if (snapshot.content === undefined) throw new FileEditPlanError(`file does not exist: ${path}`);
      this.stringContents = snapshot.content;
      this.stringMatch = matchStringEdit(snapshot.content, oldString);
    }

    if (!completedObject || this.stringContents === undefined || this.stringMatch === undefined) return CLEAR;
    const newString = decoder.field("new_string");
    const replaceAll = decoder.field("replace_all");
    if (typeof path !== "string" || typeof oldString !== "string" || typeof newString !== "string" || (replaceAll !== undefined && typeof replaceAll !== "boolean")) {
      return this.markAdvisory("edit expects string path, old_string, and new_string fields with an optional boolean replace_all");
    }
    if (replaceAll === true && this.stringMatch.matchKind !== "exact" && this.stringMatch.matchKind !== "line-ending") {
      throw new FileEditPlanError(`replace_all matched only through the ${this.stringMatch.matchKind} tier; every occurrence must match exactly. Copy old_string exactly, or edit each occurrence on its own.`);
    }
    finishStringEdit(this.stringContents, this.stringMatch, { newString, ...(replaceAll === true ? { replaceAll: true } : {}) });
    return CLEAR;
  }

  private markAdvisory(message: string): StreamingEditValidationResult {
    // SAFETY: splitting any string always returns at least one segment.
    this.advisory = { status: "advisory", message: message.split("\n", 1)[0]! };
    return this.advisory;
  }

  private markUnavailable(): StreamingEditValidationResult {
    this.unavailable = true;
    this.decoder = undefined;
    this.patch = undefined;
    this.patchPlanner = undefined;
    this.snapshots.clear();
    this.patchOperations.length = 0;
    this.stringContents = undefined;
    this.stringMatch = undefined;
    return UNAVAILABLE;
  }
}
