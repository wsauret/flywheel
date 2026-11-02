import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Redacted } from "effect"
import type { RuntimeStartupPhase } from "./app-service-types.js"
import { decodeServeStartRefusal, decodeServeStatusLine, encodeServeStatusRecord, type ServeStartRefusal } from "./serve-handshake.js"

const ACCOUNT_ATTACH_MAX_BYTES = 4_096
/** Maximum retained input while an account socket waits for project admission. */
export const ACCOUNT_ATTACH_LATER_MAX_BYTES = 64 * 1024
const LINE_FEED = 10
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

import { CLIENT_IDENTITY_PATTERN } from "./client-identity.js"

/** The hosts that ask the account socket where their client bundle is. The
 *  editor loads it from the directory the runtime names; the phone never asks,
 *  because its bundle reaches it through the relay under the same identity. */
type ClientHost = "editor"

/** Where one host's client bundle is and which client identity it belongs
 *  to. `dir` holds that host's `webview.js` and `webview.css`; `identity` is
 *  the one identity of the whole client the runtime serves, which the page
 *  states and the runtime checks at every protocol attach. */
export interface ClientBundle {
  readonly dir: string
  readonly identity: string
}

export type AccountAttach =
  | { readonly intent: "runtime" | "browser"; readonly projectRoot: string; readonly credential: string }
  /** Asks the service to make way for a successor: `cutover` when the
   *  service may be superseded by the current build or source, `restart`
   *  when a person restarts Flywheel in place (PI-INTERACTION-048). */
  | { readonly intent: "cutover"; readonly credential: string }
  | { readonly intent: "restart"; readonly credential: string }
  /** Asks where this runtime's client bundle for `host` is, without opening a project. */
  | { readonly intent: "client"; readonly host: ClientHost; readonly credential: string }
  /** Sends `request` to the account-lifetime service of `module`, without
   *  opening a project. The service answers on the connection until it ends
   *  the request, and closing the connection withdraws the request. */
  | { readonly intent: "module"; readonly module: string; readonly request: AccountModuleRequest; readonly credential: string }

/** A request to one module's account-lifetime service, in that module's own
 *  vocabulary: the account socket carries it and does not read it. */
export interface AccountModuleRequest {
  readonly [key: string]: unknown
}

type AccountAttachReadResult =
  | { readonly kind: "pending" }
  | { readonly kind: "rejected" }
  | { readonly kind: "accepted"; readonly intent: "runtime" | "browser"; readonly projectRoot: string; readonly remainder: Uint8Array }
  | { readonly kind: "accepted"; readonly intent: "cutover"; readonly remainder: Uint8Array }
  | { readonly kind: "accepted"; readonly intent: "restart"; readonly remainder: Uint8Array }
  | { readonly kind: "accepted"; readonly intent: "client"; readonly host: ClientHost; readonly remainder: Uint8Array }
  | { readonly kind: "accepted"; readonly intent: "module"; readonly module: string; readonly request: AccountModuleRequest; readonly remainder: Uint8Array }

export interface AccountAttachReader {
  readonly push: (chunk: Uint8Array) => AccountAttachReadResult
}

export type AccountAttachResponse =
  | ({ readonly kind: "phase" } & RuntimeStartupPhase)
  | { readonly kind: "starting" }
  | { readonly kind: "ready" }
  /** `refusal` names a cause whose remedy is not the lane reset. */
  | { readonly kind: "failed"; readonly error: string; readonly refusal?: ServeStartRefusal }
  | { readonly kind: "busy" }
  | { readonly kind: "retiring" }
  /** The answer to a `client` attach. */
  | { readonly kind: "client"; readonly bundle: ClientBundle }
  /** One answer to a `module` attach, in the module's own vocabulary. */
  | { readonly kind: "answer"; readonly payload: unknown }
  /** The module service ended the request of a `module` attach. */
  | { readonly kind: "end" }

type AccountAttachResponseReadResult =
  | { readonly kind: "pending" }
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly remainder: Uint8Array }
  | { readonly kind: "failed"; readonly error: string; readonly refusal?: ServeStartRefusal }
  | { readonly kind: "busy" }
  | { readonly kind: "retiring" }
  | { readonly kind: "client"; readonly bundle: ClientBundle }

export interface AccountAttachResponseReader {
  readonly push: (chunk: Uint8Array) => AccountAttachResponseReadResult
}

interface UnknownAccountAttach {
  readonly [key: string]: unknown
}

/** Mint a 256-bit URL-safe credential for account-socket admission. */
export function newAccountAttachCredential(): string {
  return randomBytes(32).toString("base64url")
}

export function isClientIdentity(value: unknown): value is string {
  return typeof value === "string" && CLIENT_IDENTITY_PATTERN.test(value)
}

/** Encode the one JSON line that precedes protocol bytes on an account socket. */
export function encodeAccountAttach(attach: AccountAttach): string {
  const line = `${JSON.stringify({ flywheel: "account.attach", ...attach })}\n`
  if (encoder.encode(line).length - 1 > ACCOUNT_ATTACH_MAX_BYTES) throw new Error("AccountAttach exceeds the protocol bound")
  return line
}

/** Incrementally admit one account connection. Credential rejection happens
 * before project-root canonicalization, and accepted output retains every byte
 * after the JSON-line delimiter. */
export function createAccountAttachReader(options: {
  readonly credential: Redacted.Redacted<string>
  readonly canonicalizeProjectRoot: (projectRoot: string) => string
}): AccountAttachReader {
  let buffered = new Uint8Array(0)
  let settled: "accepted" | "rejected" | undefined

  return {
    push(chunk) {
      if (settled !== undefined) return { kind: "rejected" }
      const delimiter = chunk.indexOf(LINE_FEED)
      if (delimiter < 0 && buffered.length + chunk.length > ACCOUNT_ATTACH_MAX_BYTES) {
        settled = "rejected"
        return { kind: "rejected" }
      }

      const joined = new Uint8Array(buffered.length + chunk.length)
      joined.set(buffered)
      joined.set(chunk, buffered.length)
      const lineEnd = joined.indexOf(LINE_FEED)
      if (lineEnd < 0) {
        buffered = joined
        return { kind: "pending" }
      }
      if (lineEnd > ACCOUNT_ATTACH_MAX_BYTES) {
        settled = "rejected"
        return { kind: "rejected" }
      }

      const parsed = decodeAttach(joined.subarray(0, lineEnd))
      if (!parsed || !credentialMatches(Redacted.value(options.credential), parsed.credential)) {
        settled = "rejected"
        return { kind: "rejected" }
      }
      const remainder = joined.slice(lineEnd + 1)
      if (parsed.intent === "cutover" || parsed.intent === "restart") {
        settled = "accepted"
        return { kind: "accepted", intent: parsed.intent, remainder }
      }
      if (parsed.intent === "client") {
        settled = "accepted"
        return { kind: "accepted", intent: "client", host: parsed.host, remainder }
      }
      if (parsed.intent === "module") {
        settled = "accepted"
        return { kind: "accepted", intent: "module", module: parsed.module, request: parsed.request, remainder }
      }
      try {
        const projectRoot = options.canonicalizeProjectRoot(parsed.projectRoot)
        settled = "accepted"
        return { kind: "accepted", intent: parsed.intent, projectRoot, remainder }
      } catch {
        settled = "rejected"
        return { kind: "rejected" }
      }
    },
  }
}

/** Encode one authenticated account-socket response. */
export function encodeAccountAttachResponse(response: AccountAttachResponse): string {
  switch (response.kind) {
    case "phase": {
      const { kind: _kind, ...phase } = response
      return encodeServeStatusRecord({ flywheel: "serve.startup.phase", ...phase })
    }
    case "failed":
      return `${JSON.stringify({ flywheel: "account.attach.failed", error: response.error, ...(response.refusal === undefined ? {} : { refusal: response.refusal }) })}\n`
    case "busy":
    case "retiring":
      // A cutover and a restart request share these answers.
      return `${JSON.stringify({ flywheel: `account.cutover.${response.kind}` })}\n`
    case "client":
      return `${JSON.stringify({ flywheel: "account.client", dir: response.bundle.dir, identity: response.bundle.identity })}\n`
    case "answer":
      return `${JSON.stringify({ flywheel: "account.module.answer", payload: response.payload })}\n`
    case "end":
      return `${JSON.stringify({ flywheel: "account.module.end" })}\n`
    case "starting":
    case "ready":
      return `${JSON.stringify({ flywheel: `account.attach.${response.kind}` })}\n`
  }
}

/** Read responses and report every startup phase, preserving RPC bytes coalesced with ready.
 * Without a reporter, phase frames are consumed without notification. Malformed frames fail the attach. */
export function createAccountAttachResponseReader(onStartupPhase?: (phase: RuntimeStartupPhase) => void): AccountAttachResponseReader {
  let buffered = new Uint8Array(0)
  let settled = false
  const push = (chunk: Uint8Array): AccountAttachResponseReadResult => {
    if (settled) return { kind: "failed", error: "Account attach response is already settled" }
    const joined = new Uint8Array(buffered.length + chunk.length)
    joined.set(buffered)
    joined.set(chunk, buffered.length)
    const lineEnd = joined.indexOf(LINE_FEED)
    if (lineEnd < 0) {
      if (joined.length > ACCOUNT_ATTACH_MAX_BYTES) {
        settled = true
        return { kind: "failed", error: "Account attach response exceeds the protocol bound" }
      }
      buffered = joined
      return { kind: "pending" }
    }
    if (lineEnd > ACCOUNT_ATTACH_MAX_BYTES) {
      settled = true
      return { kind: "failed", error: "Account attach response exceeds the protocol bound" }
    }
    let value: unknown
    try {
      value = JSON.parse(decoder.decode(joined.subarray(0, lineEnd)))
    } catch {
      settled = true
      return { kind: "failed", error: "Account attach response is malformed" }
    }
    if (!isRecord(value)) {
      settled = true
      return { kind: "failed", error: "Account attach response is malformed" }
    }
    if (value.flywheel === "serve.startup.phase") {
      const record = decodeServeStatusLine(JSON.stringify(value))
      if (record?.flywheel !== "serve.startup.phase") {
        settled = true
        return { kind: "failed", error: "Account attach response is malformed" }
      }
      const { flywheel: _flywheel, ...phase } = record
      onStartupPhase?.(phase)
      buffered = joined.slice(lineEnd + 1)
      if (buffered.length === 0) return { kind: "pending" }
      return push(new Uint8Array(0))
    }
    if (value.flywheel === "account.attach.starting" && Object.keys(value).length === 1) {
      buffered = joined.slice(lineEnd + 1)
      if (buffered.length === 0) return { kind: "starting" }
      return push(new Uint8Array(0))
    }
    if (value.flywheel === "account.attach.ready" && Object.keys(value).length === 1) {
      settled = true
      return { kind: "ready", remainder: joined.slice(lineEnd + 1) }
    }
    if (value.flywheel === "account.cutover.busy" && Object.keys(value).length === 1) {
      settled = true
      return { kind: "busy" }
    }
    if (value.flywheel === "account.cutover.retiring" && Object.keys(value).length === 1) {
      settled = true
      return { kind: "retiring" }
    }
    if (
      value.flywheel === "account.attach.failed"
      && typeof value.error === "string"
      && Object.keys(value).every((key) => key === "flywheel" || key === "error" || key === "refusal")
    ) {
      settled = true
      // A refusal of a kind this build does not know reads as the failure alone.
      const refusal = decodeServeStartRefusal(value.refusal)
      return { kind: "failed", error: value.error, ...(refusal === undefined ? {} : { refusal }) }
    }
    if (
      value.flywheel === "account.client"
      && Object.keys(value).length === 3
      && typeof value.dir === "string"
      && value.dir.length > 0
      && isClientIdentity(value.identity)
    ) {
      settled = true
      return { kind: "client", bundle: { dir: value.dir, identity: value.identity } }
    }
    settled = true
    return { kind: "failed", error: "Account attach response is malformed" }
  }
  return { push }
}

type AccountModuleAnswerEvent =
  | { readonly kind: "answer"; readonly payload: unknown }
  | { readonly kind: "end" }
  | { readonly kind: "failed"; readonly error: string }

/** Reads the answers to a `module` attach: each chunk yields the whole lines
 *  it completed, in order. `end` and `failed` are each the last event; a
 *  line this build cannot read fails the request. */
interface AccountModuleAnswerReader {
  readonly push: (chunk: Uint8Array) => readonly AccountModuleAnswerEvent[]
}

export function createAccountModuleAnswerReader(): AccountModuleAnswerReader {
  let buffered = new Uint8Array(0)
  let settled = false
  return {
    push(chunk) {
      const events: AccountModuleAnswerEvent[] = []
      const fail = (error: string): readonly AccountModuleAnswerEvent[] => {
        settled = true
        return [...events, { kind: "failed", error }]
      }
      if (settled) return []
      const joined = new Uint8Array(buffered.length + chunk.length)
      joined.set(buffered)
      joined.set(chunk, buffered.length)
      let start = 0
      for (let lineEnd = joined.indexOf(LINE_FEED); lineEnd >= 0; lineEnd = joined.indexOf(LINE_FEED, start)) {
        if (lineEnd - start > ACCOUNT_ATTACH_MAX_BYTES) return fail("Account module answer exceeds the protocol bound")
        let value: unknown
        try {
          value = JSON.parse(decoder.decode(joined.subarray(start, lineEnd)))
        } catch {
          return fail("Account module answer is malformed")
        }
        start = lineEnd + 1
        if (!isRecord(value)) return fail("Account module answer is malformed")
        if (value.flywheel === "account.module.answer" && Object.keys(value).length === 2 && "payload" in value) {
          events.push({ kind: "answer", payload: value.payload })
          continue
        }
        if (value.flywheel === "account.module.end" && Object.keys(value).length === 1) {
          settled = true
          return [...events, { kind: "end" }]
        }
        if (value.flywheel === "account.attach.failed" && typeof value.error === "string") return fail(value.error)
        return fail("Account module answer is malformed")
      }
      buffered = joined.slice(start)
      if (buffered.length > ACCOUNT_ATTACH_MAX_BYTES) return fail("Account module answer exceeds the protocol bound")
      return events
    },
  }
}

function decodeAttach(bytes: Uint8Array): AccountAttach | undefined {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.flywheel !== "account.attach" || typeof value.credential !== "string") return undefined
  const keys = Object.keys(value).length
  if ((value.intent === "cutover" || value.intent === "restart") && keys === 3) {
    return { intent: value.intent, credential: value.credential }
  }
  if (value.intent === "client" && keys === 4 && value.host === "editor") {
    return { intent: "client", host: value.host, credential: value.credential }
  }
  if (value.intent === "module" && keys === 5 && typeof value.module === "string" && value.module.length > 0 && isRecord(value.request)) {
    return { intent: "module", module: value.module, request: value.request, credential: value.credential }
  }
  if (
    keys === 4
    && (value.intent === "runtime" || value.intent === "browser")
    && typeof value.projectRoot === "string"
  ) return { intent: value.intent, projectRoot: value.projectRoot, credential: value.credential }
  return undefined
}

function isRecord(value: unknown): value is UnknownAccountAttach {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function credentialMatches(expected: string, offered: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest()
  const offeredDigest = createHash("sha256").update(offered).digest()
  return timingSafeEqual(expectedDigest, offeredDigest)
}
