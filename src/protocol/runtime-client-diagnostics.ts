import { Schema } from "effect"

export const RuntimeCursorDescriptorSchema = Schema.Struct({
  scope: Schema.String,
  domain: Schema.String,
  sessionId: Schema.optionalKey(Schema.String),
  workflowId: Schema.optionalKey(Schema.String),
})

const Milliseconds = Schema.Number

/** How the lane before an attach ended: `first` for the connection's first
 *  lane, `requested` for a reconnect or a resume that found the lane down,
 *  `probe` for a resume whose round trip got no answer by its deadline,
 *  `ended` for a lane the runtime closed, and `failed` for one that broke. */
const LaneEndKindSchema = Schema.Literals(["first", "requested", "probe", "ended", "failed"])

/** The previous lane's observed end, without socket reason text or error content. */
const LaneEndCauseSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("closed"), code: Schema.Number }),
  Schema.Struct({ kind: Schema.Literals(["silent", "read-error", "write-error", "refused", "defect", "requested", "probe"]) }),
])

const InputTime = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1e12))
const InputId = Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^[a-zA-Z0-9_-]+$/))
const InputCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1e9))
const InputTapSchema = Schema.Struct({
  gestureId: InputCount,
  controlId: InputCount,
  maxTouches: Schema.optionalKey(InputCount),
  durationMs: Schema.optionalKey(InputTime),
  maxDisplacementPx: InputTime,
  touchStartPrevented: Schema.optionalKey(Schema.Boolean),
  touchMovePrevented: Schema.optionalKey(Schema.Boolean),
  touchEndPrevented: Schema.optionalKey(Schema.Boolean),
  touchCancelled: Schema.optionalKey(Schema.Boolean),
  mouseStages: Schema.Array(Schema.Literals(["mouseover", "mousemove", "mousedown", "mouseup", "click"])).check(Schema.isMaxLength(5)),
  controlConnected: Schema.optionalKey(Schema.Boolean),
  releaseOnOriginalControl: Schema.optionalKey(Schema.Boolean),
  clickOnOtherControl: Schema.optionalKey(Schema.Boolean),
})
const InputSampleSchema = Schema.Struct({
  event: Schema.Literals(["pointerdown", "pointerup", "pointercancel", "click", "keydown", "input"]),
  input: Schema.Literals(["touch", "mouse", "pen", "keyboard", "other"]),
  control: Schema.Literals(["session", "back", "question", "disclosure", "editable", "selection", "button", "link", "other"]),
  area: Schema.Literals(["sessions", "question", "transcript", "composer", "toolbar", "dialog", "other"]),
  atMs: InputTime,
  dispatchDelayMs: InputTime,
  frameWaitMs: Schema.optionalKey(InputTime),
  defaultPrevented: Schema.Boolean,
  tap: Schema.optionalKey(InputTapSchema),
})

/** Content-free, bounded evidence from one mounted client's passive observer.
 * Frame wait measures the next animation callback, not a rendered paint. */
export const InputResponsivenessDiagnosticSchema = Schema.Struct({
  kind: Schema.Literal("input_responsiveness"),
  clientInstanceId: InputId,
  sessionId: Schema.optionalKey(InputId),
  connection: Schema.Literals(["connecting", "connected", "recovering", "closed"]),
  screen: Schema.Literals(["sessions", "chat", "wide", "dialog"]),
  paneInert: Schema.Boolean,
  dragging: Schema.Boolean,
  phase: Schema.Literals(["first", "summary"]),
  anomaly: Schema.Literals(["dispatch_delay", "frame_delay", "unmatched_tap"]),
  dispatchDelayed: InputCount,
  frameDelayed: InputCount,
  unmatchedTap: InputCount,
  recent: Schema.Array(InputSampleSchema).check(Schema.isMaxLength(16)),
})
export type InputResponsivenessDiagnostic = typeof InputResponsivenessDiagnosticSchema.Type
export type InputDiagnosticSample = typeof InputSampleSchema.Type

export const RuntimeClientDiagnosticSchema = Schema.Union([
  InputResponsivenessDiagnosticSchema,
  Schema.Struct({
    kind: Schema.Literal("background_read"),
    reader: Schema.String.check(Schema.isMaxLength(128)),
    errorKind: Schema.String.check(Schema.isMaxLength(64)),
    phase: Schema.Literals(["failed", "recovered", "disposed"]),
    repeats: InputCount,
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported_event"),
    eventType: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported_patch"),
    cursor: RuntimeCursorDescriptorSchema,
    payloadKind: Schema.String,
  }),
  /** One record for each lane a client opens: how the previous lane ended
   *  and where the time to this one went. Durations and kinds only. */
  Schema.Struct({
    kind: Schema.Literal("lane_attach"),
    previousEnd: LaneEndKindSchema,
    /** Optional so a record from a client built before this field stays readable. */
    previousCause: Schema.optionalKey(LaneEndCauseSchema),
    previousVisibility: Schema.optionalKey(Schema.Literals(["visible", "hidden"])),
    /** Dial attempts this attach took, the one that opened the lane included. */
    attempts: Schema.Number,
    /** From the previous lane's end to this lane's subscription written;
     *  absent for a first lane. */
    gapMs: Schema.optionalKey(Milliseconds),
    /** Time spent in reconnect backoff between those attempts. */
    backoffMs: Milliseconds,
    /** From the opening attempt's start to its subscription written. */
    dialMs: Milliseconds,
    /** From the subscription written to the runtime's first frame. */
    answerMs: Milliseconds,
    /** From the subscription written to the first transcript read written on
     *  this lane, when one was written before the first frame. */
    transcriptMs: Schema.optionalKey(Milliseconds),
    /** Calls written in the burst the lane opened with. */
    burst: Schema.Number,
  }),
])

export type RuntimeClientDiagnostic = typeof RuntimeClientDiagnosticSchema.Type
export type LaneEndCause = typeof LaneEndCauseSchema.Type
