import type { ProvisionalDiff } from "../output-blocks.js";
import { getToolDisplay } from "../tools/tool-display-registry.js";
import type { StreamingRowDerivation, ToolRowPresentation } from "../tools/types.js";
import type { ToolInput } from "./output-projection-events.js";
import { declaredFieldName, MAX_STREAMING_TOOL_INPUT_BYTES, TopLevelJsonStringDecoder, type DecodedStringAppend } from "./partial-json.js";
import { createProvisionalDiffInput, type ProvisionalDiffInput, type ProvisionalDiffInputKind } from "./provisional-diff-input.js";
import { provisionalDiffDisplayPaths } from "./display-paths.js";

interface StreamingInput {
  /** The canonical tool name the stream started under. */
  readonly name: string;
  readonly decoder: TopLevelJsonStringDecoder;
  /** The row derivation of a display whose presentation fields can grow long. */
  readonly row?: StreamingRowDerivation;
  proposal?: { readonly kind: ProvisionalDiffInputKind; readonly input: ProvisionalDiffInput };
}

/** A file change's proposed diff, in the path form shown to a user. */
export interface StreamingProposal {
  readonly fileChangeKind: ProvisionalDiffInputKind;
  readonly proposedDiff: ProvisionalDiff;
}

/** What one input delta changed. `proposedDiff` is present exactly when the
 *  call streams a file-change proposal, which then owns the row's live body. */
export type StreamingInputUpdate =
  | { readonly kind: "failed"; readonly proposedDiff: ProvisionalDiff | undefined }
  | {
    readonly kind: "decoded";
    readonly proposedDiff: ProvisionalDiff | undefined;
    /** Newly decoded text of the declared fields. */
    readonly additions: DecodedStringAppend["additions"];
    /** The call's `path` field once its string closes. */
    readonly filePath: string | undefined;
    /** Present when a declared presentation field changed: the partial input a row header refines from. */
    readonly presentationInput: ToolInput | undefined;
    /** Present with `presentationInput` when the display derives its row from
     *  each delta, at a cost bounded by the delta. It equals what
     *  `resolveToolRowPresentation` gives for `presentationInput` once the
     *  presentation fields complete; see `StreamingRowDerivation.advance`. */
    readonly row: ToolRowPresentation | undefined;
  };

/**
 * Owns the incremental decoding of streamed tool-call arguments and the
 * provisional diffs a file change proposes while its arguments stream. It
 * keeps no row state: callers apply the updates it returns to their rows.
 */
export class StreamingToolInputs {
  private readonly inputs = new Map<string, StreamingInput>();

  constructor(private readonly executionCwd: string) {}

  /** Begins decoding a call whose arguments stream: its declared body and
   *  presentation fields. */
  start(toolUseId: string, name: string): void {
    const contract = getToolDisplay(name);
    const declaration = contract.streamingInput;
    const decoder = new TopLevelJsonStringDecoder(declaration
      ? [...Object.keys(declaration.bodyFields), ...declaration.presentationFields]
      : []);
    const fileChangeKind = contract.fileChangeKind;
    const row = declaration?.row?.(this.executionCwd);
    this.inputs.set(toolUseId, {
      name,
      decoder,
      ...(row ? { row } : {}),
      ...(typeof fileChangeKind === "string" ? { proposal: { kind: fileChangeKind, input: createProvisionalDiffInput(fileChangeKind) } } : {}),
    });
  }

  /** Whether the call streams a file-change proposal. */
  proposes(toolUseId: string): boolean {
    return this.inputs.get(toolUseId)?.proposal !== undefined;
  }

  /** Decodes one argument delta. Undefined when the call's arguments do not stream. */
  append(toolUseId: string, delta: string): StreamingInputUpdate | undefined {
    const entry = this.inputs.get(toolUseId);
    if (!entry) return undefined;
    const { decoder } = entry;
    const decoded = decoder.append(delta);
    const proposal = this.proposal(entry, decoded);
    if (decoder.failed) {
      proposal?.input.markUnavailable(decoder.acceptedBytes + Buffer.byteLength(delta) > MAX_STREAMING_TOOL_INPUT_BYTES ? "over-bound" : "malformed");
      return { kind: "failed", proposedDiff: proposal ? this.displayed(proposal.input) : undefined };
    }
    proposal?.input.append(decoded.additions, decoded.completedFields);
    const declaration = getToolDisplay(entry.name).streamingInput;
    const presentationChanged = declaration?.presentationFields.some((field) =>
      decoded.additions[field] !== undefined || decoded.completedFields.includes(field));
    let presentationInput: ToolInput | undefined;
    let row: ToolRowPresentation | undefined;
    if (declaration && presentationChanged) {
      const fields = decoder.fields;
      presentationInput = { ...fields };
      for (const field of declaration.presentationFields) {
        const value = decoder.field(field);
        if (value !== undefined) presentationInput[field] = value;
      }
      row = entry.row?.advance(decoded.additions, fields);
    }
    return {
      kind: "decoded",
      proposedDiff: proposal ? this.displayed(proposal.input) : undefined,
      additions: decoded.additions,
      filePath: decoder.completedString("path"),
      presentationInput,
      row,
    };
  }

  /** Ends a call's stream with its complete input, returning the proposal a
   *  file change shows until its result lands. A call that never streamed
   *  still gets one built from the complete input. */
  complete(toolUseId: string, name: string, input: ToolInput): StreamingProposal | undefined {
    const current = this.inputs.get(toolUseId)?.proposal;
    this.inputs.delete(toolUseId);
    const contract = getToolDisplay(name);
    if (!contract.fileChangeKind) return undefined;
    const kind = typeof contract.fileChangeKind === "function" ? contract.fileChangeKind(input) : contract.fileChangeKind;
    const proposal = current?.kind === kind ? current.input : createProvisionalDiffInput(kind);
    proposal.complete(input);
    return { fileChangeKind: kind, proposedDiff: this.displayed(proposal) };
  }

  /** Ends a call's stream when its result lands, returning the proposal it had streamed. */
  settle(toolUseId: string): StreamingProposal | undefined {
    const proposal = this.inputs.get(toolUseId)?.proposal;
    this.inputs.delete(toolUseId);
    return proposal ? { fileChangeKind: proposal.kind, proposedDiff: this.displayed(proposal.input) } : undefined;
  }

  /** Ends a call's stream without a proposal. */
  discard(toolUseId: string): void {
    this.inputs.delete(toolUseId);
  }

  /** The proposals still streaming, for rows that settle before their input completes. */
  retain(): readonly (StreamingProposal & { readonly toolUseId: string })[] {
    return [...this.inputs].flatMap(([toolUseId, { proposal }]) =>
      proposal ? [{ toolUseId, fileChangeKind: proposal.kind, proposedDiff: this.displayed(proposal.input) }] : []);
  }

  reset(): void {
    this.inputs.clear();
  }

  /** The proposal a call streams. A file change whose kind depends on its
   *  input starts one once a body field arrives, seeded with the fields
   *  decoded before it. */
  private proposal(entry: StreamingInput, decoded: DecodedStringAppend): StreamingInput["proposal"] {
    if (entry.proposal) return entry.proposal;
    const contract = getToolDisplay(entry.name);
    if (typeof contract.fileChangeKind !== "function") return undefined;
    const { decoder } = entry;
    const bodyFields = Object.keys(contract.streamingInput?.bodyFields ?? {});
    const bodyStarted = Object.keys(decoded.additions).some((field) => bodyFields.includes(declaredFieldName(field)))
      || bodyFields.some((field) => decoder.field(field) !== undefined);
    if (!bodyStarted) return undefined;
    const fields = decoder.fields;
    const partialInput: ToolInput = { ...fields };
    for (const field of bodyFields) {
      const value = decoder.field(field);
      if (value !== undefined) partialInput[field] = value;
    }
    const kind = contract.fileChangeKind(partialInput);
    const proposal = { kind, input: createProvisionalDiffInput(kind) };
    const priorFields: { [field: string]: string } = {};
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === "string" && decoded.additions[field] === undefined) priorFields[field] = value;
    }
    proposal.input.append(priorFields, Object.keys(priorFields));
    entry.proposal = proposal;
    return proposal;
  }

  private displayed(input: ProvisionalDiffInput): ProvisionalDiff {
    return provisionalDiffDisplayPaths(input.snapshot(), this.executionCwd);
  }
}
