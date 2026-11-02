/**
 * Process-global counter of in-flight outbound LLM requests.
 *
 * Lets the request-timing fact record how many model requests were already on
 * the wire when this one was sent, so dead-zone tails can be sliced by real
 * concurrency. Incremented/decremented by provider adapters around the request
 * lifecycle (send -> stream end). Anthropic wires this today; OpenAI/ChatGPT backend can
 * call the same pair to make the count cross-provider.
 */

let inFlight = 0;

/** Mark a request as sent; returns the in-flight count including this one. */
export function beginOutboundRequest(): number {
  inFlight += 1;
  return inFlight;
}

export function endOutboundRequest(): void {
  if (inFlight > 0) inFlight -= 1;
}
