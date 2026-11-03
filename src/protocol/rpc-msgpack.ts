/**
 * The MessagePack RPC serialization that every Flywheel client and runtime
 * speaks, and that every installed release before effect 4.1 speaks too.
 *
 * Ported from effect 4.0.0-beta.84, `src/unstable/rpc/RpcSerialization.ts`
 * (`makeMsgPack`, `msgPack`, `layerMsgPack`), MIT License, Copyright (c) 2023
 * Effectful Technologies Inc. effect 4.1 removed it; its replacements change
 * the bytes on the wire, and a runtime and a client of different releases must
 * still understand each other. Copied first, then changed only as this ledger
 * states:
 *
 * - The imports name `effect` and `effect/rpc` instead of upstream's relative
 *   paths, so the module-local `RpcSerialization` service is reached through
 *   its module namespace.
 * - The service sets `codecFor` to the JSON codec of `RpcSerialization.json`,
 *   which 4.1 requires and which is the codec that beta.84 applied to every
 *   payload, exit, and defect before it packed them.
 * - A `SAFETY:` comment and two lint suppressions with their reasons mark
 *   the parameter reassignment and the `any` cast, as Flywheel's lint
 *   requires.
 * - `makeMsgPack` is not exported: Flywheel uses the one `useRecords: true`
 *   instance.
 */
import * as Msgpackr from "msgpackr"
import { Layer } from "effect"
import { RpcSerialization } from "effect/rpc"

/**
 * Create a MessagePack serialization with custom msgpackr options.
 *
 * @category serialization
 * @since 4.0.0
 */
const makeMsgPack = (options?: Msgpackr.Options | undefined): RpcSerialization.RpcSerialization["Service"] =>
  RpcSerialization.RpcSerialization.of({
    contentType: "application/msgpack",
    includesFraming: true,
    codecFor: RpcSerialization.json.codecFor,
    makeUnsafe: () => {
      const unpackr = new Msgpackr.Unpackr(options)
      const packr = new Msgpackr.Packr(options)
      const encoder = new TextEncoder()
      let incomplete: Uint8Array | undefined = undefined
      return {
        decode(bytes) {
          let buf = typeof bytes === "string" ? encoder.encode(bytes) : bytes
          if (incomplete !== undefined) {
            const prev = buf
            // oxlint-disable-next-line eslint/no-param-reassign -- verbatim upstream: the joined buffer replaces the frame in place
            bytes = new Uint8Array(incomplete.length + buf.length)
            bytes.set(incomplete)
            bytes.set(prev, incomplete.length)
            buf = bytes
            incomplete = undefined
          }
          try {
            return unpackr.unpackMultiple(buf)
          } catch (error_) {
            // SAFETY: msgpackr throws an error that carries `incomplete`,
            // `lastPosition`, and `values` when a frame ends mid-message.
            // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-explicit-any -- boundary: msgpackr's incomplete-frame error is untyped
            const error = error_ as any
            if (error.incomplete) {
              incomplete = buf.subarray(error.lastPosition)
              return error.values ?? []
            }
            throw error_
          }
        },
        encode: (response) => packr.pack(response)
      }
    }
  })

/**
 * Default MessagePack RPC serialization using record support and built-in
 * message framing.
 *
 * @category serialization
 * @since 4.0.0
 */
export const msgPack: RpcSerialization.RpcSerialization["Service"] = makeMsgPack({ useRecords: true })

/**
 * RPC serialization layer that uses MessagePack for serialization.
 *
 * **Details**
 *
 * MessagePack has a more compact binary format compared to JSON and NDJSON. It
 * also has better support for binary data.
 *
 * @category serialization
 * @since 4.0.0
 */
export const layerMsgPack: Layer.Layer<RpcSerialization.RpcSerialization> = Layer.succeed(RpcSerialization.RpcSerialization)(msgPack)
