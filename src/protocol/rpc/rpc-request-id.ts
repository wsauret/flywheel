import { RpcMessage } from "effect/rpc"

let next = 0

/** The `generateRequestId` of every `RpcClient.make`. One sequence serves the
 *  whole process, so two clients that share one protocol lane never reuse an
 *  id. Each id goes on the wire as a string of decimal digits: a runtime on a
 *  release before effect 4.1 reads only such an id and answers any other with
 *  a defect, which would turn its refusal of this client's protocol version
 *  (`RuntimeEventsAttachSchema`) into a failure the client cannot explain. */
export function stringRequestId(): RpcMessage.RequestId {
  return RpcMessage.RequestId(String(next++))
}
