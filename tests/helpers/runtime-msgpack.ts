import { Effect } from "effect"
import { RpcSerialization } from "effect/rpc"

import { layerMsgPack } from "../../src/protocol/rpc/rpc-msgpack.js"

/** The MessagePack serialization that the runtime socket speaks, read from its production layer. */
export const runtimeMsgPack = Effect.runSync(Effect.provide(Effect.service(RpcSerialization.RpcSerialization), layerMsgPack))
