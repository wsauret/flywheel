# elegance-alert-fallback: seeded defect rationale

## duplicate-channel-list (preferences.ts, channels.ts)

channels.ts owns the set of channels: `CHANNELS = ["email", "sms", "push"] as const`, and the `Channel` type is derived from it. The change adds `ALLOWED_CHANNELS: readonly Channel[] = ["email", "sms", "push"]` in preferences.ts and validates the settings form against that copy. The type annotation makes the copy look safe, but it only checks that every entry is a channel, not that every channel is listed. When a fourth channel is added to `CHANNELS`, the type, `addressFor`, and the sender pick it up, while `parseChannelOrder` keeps rejecting it as unknown. One value, two owners. `parseChannelOrder` should search `CHANNELS`.

## single-use-delivery-strategy (delivery.ts, alerts.ts)

`DeliveryStrategy` has exactly one implementation (`FallbackDeliveryStrategy`), one caller (`AlertDispatcher`), and a factory (`createDeliveryStrategy`) that takes no choice and always returns that implementation. The dispatcher builds it in its own constructor, so the interface is not even a test seam: a test cannot inject another strategy. Interface, class, and factory spread one loop over three names. The elegant shape is one function or class that the dispatcher calls directly; an interface can appear when a second strategy does. It looks deliberate because "strategy" is a named pattern and the pieces are tidy.

## What is intended

- The fallback loop catches every send error on purpose: a failed channel is the reason to try the next one, and the error text is kept for the feed.
- `parseChannelOrder` rejecting unknown names and repeats is validation at a real boundary (text typed into a settings form). `saveAlertSettings` in settings-page.ts is its caller, so the parser is wired, not dead.
- `DeliveryResult` and `DeliveryAttempt` are read by `dispatchForFeed`, so they are not dead.
