import { Redacted } from "effect"

import type { GuardianRequest, GuardianToken } from "../../../src/infra/process-guardian-protocol.js"
import type { StopHold } from "../../../src/infra/stop-hold.js"

/** The frames a host sends a process guardian, under one capability. */

const encoder = new TextEncoder()

/** The capability one control channel established, and one nobody granted. A
 *  capability is bytes, so a test that needs to read one back decodes it. */
export function capabilityOf(token: string): GuardianToken {
  return Redacted.make(encoder.encode(token))
}

export function tokenOf(capability: GuardianToken): string {
  return new TextDecoder().decode(Redacted.value(capability))
}

export const CAPABILITY = capabilityOf("capability-under-test")
export const IMPOSTOR = capabilityOf("capability-of-nobody")
export const GENERATION = "gen:under-test"

export function hello(id: number, capability = CAPABILITY): GuardianRequest {
  return { v: 1, kind: "hello", id, capability }
}

export function open(id: number, generation = GENERATION, capability = CAPABILITY): GuardianRequest {
  return { v: 1, kind: "open", id, capability, generation }
}

export function adopt(id: number, token: string, pid: number, generation = GENERATION, capability = CAPABILITY, stopHold: StopHold | null = null): GuardianRequest {
  return { v: 1, kind: "adopt", id, capability, generation, token, pid, stopHold }
}

export function release(id: number, token: string, generation = GENERATION, capability = CAPABILITY): GuardianRequest {
  return { v: 1, kind: "release", id, capability, generation, token }
}

export function closeGeneration(id: number, generation = GENERATION, capability = CAPABILITY): GuardianRequest {
  return { v: 1, kind: "close", id, capability, generation }
}
