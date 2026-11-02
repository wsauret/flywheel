/** Redaction of the tool inputs a durable runtime fact retains.
 *
 *  A tool call's arguments are recorded verbatim in the event store, so for the
 *  two learning-store tools the fact would hold authored bytes before the store
 *  applies its own redaction. `redactSecrets` masks only explicit recognized
 *  credential formats. The same value-pattern pass is applied here so matching
 *  values do not survive in the durable copy; unrecognized formats remain verbatim.
 *
 *  Every string leaf of the input is redacted, whatever field or nesting depth
 *  it arrived in, so a new field or a batch item is covered the day it is
 *  added. */

import { redactDeep } from "./redact-secrets.js"


export interface DurableToolInput {
  [key: string]: unknown
}
export function redactDurableToolInput(_toolName: string, input: DurableToolInput): DurableToolInput {
  const redacted: DurableToolInput = {}
  for (const [key, value] of Object.entries(input)) redacted[key] = redactDeep(value)
  return redacted
}
