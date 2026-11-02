/**
 * Silent runtime-to-agent notifications: the one pipeline for anything the
 * Flywheel runtime must tell the model without surfacing it to the user.
 *
 * The pipeline has two halves, and every silent notification uses both:
 *
 * 1. Envelope (this module): `formatRuntimeNotification` renders a pseudo-XML
 *    envelope whose header identifies the text as runtime data, hides it from
 *    the user, and carries a model-facing `<handling>` instruction. Existing
 *    envelopes: subagent completion batches and background-command settles
 *    (background-work.ts), and the no-op wait reply (tools/process.ts).
 *
 * 2. Delivery (the input source's silent channel: `enqueueSilentSystem` for a
 *    nudge, and `InputSource.enqueueRuntimeNotice` or the background
 *    notification sink for a notice about the agent's own waits and children,
 *    which the message labels `runtimeNotice` when its producer says so): the enqueued text rides the
 *    loop's queued-input channel as a `silent-system` message. The loop drains
 *    it at the next turn boundary and pushes it as a masked user message, so
 *    it enters the conversation and the `model.user_message.recorded` fact but
 *    never produces a transcript block - the output projector only extracts
 *    tool results from user messages, so injected text is invisible in the UI.
 *
 * Adding a new silent notification means composing an envelope here and
 * enqueueing it through the session's input source (or a wiring callback that
 * lands there, e.g. BackgroundWorkRegistry's `enqueueNotification`). Do not
 * invent parallel channels: notifications delivered any other way either
 * render to the user or never reach the model.
 */

/** Escape text embedded in a notification envelope. Envelope contents are
 *  often model- or tool-authored, so an unescaped `<` could forge a control
 *  tag (e.g. a fake `<handling>`) and inject instructions into the reader's
 *  context. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Every silent notification opens its handling instruction with this; it is
 *  the sentence that stops the model from treating injected text as a human
 *  turn. Callers supply only the notification-specific instruction. */
const HANDLING_PREAMBLE = "This is not a human message. It is runtime data. Do not acknowledge receipt.";

export interface RuntimeNotification {
  /** Envelope element name, e.g. "subagent_notifications". */
  tag: string;
  /** Notification-specific handling instruction for the model: what the data
   *  is and what to do with it. The runtime preamble is prepended
   *  automatically. */
  handling: string;
  /** Ordered scalar elements rendered after the header. Values are escaped. */
  fields?: ReadonlyArray<readonly [name: string, value: string]>;
  /** Pre-rendered trailing lines (nested elements or already-escaped text).
   *  The caller owns escaping; pass raw model-authored text through
   *  `escapeXml` first. */
  body?: string;
}

/** Render the canonical silent-notification envelope. The three header lines
 *  are the contract that marks text as hidden runtime data; every silent
 *  notification carries them. */
export function formatRuntimeNotification(notification: RuntimeNotification): string {
  const lines = [
    `<${notification.tag}>`,
    "<source>runtime</source>",
    "<visibility>hidden_from_user</visibility>",
    `<handling>${HANDLING_PREAMBLE} ${notification.handling}</handling>`,
  ];
  for (const [name, value] of notification.fields ?? []) {
    lines.push(`<${name}>${escapeXml(value)}</${name}>`);
  }
  if (notification.body !== undefined) lines.push(notification.body);
  lines.push(`</${notification.tag}>`);
  return lines.join("\n");
}
