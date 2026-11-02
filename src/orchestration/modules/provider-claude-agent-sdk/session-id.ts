import { randomBytes } from "node:crypto";

/** A fixed tag in the custom bits of every bridge session id. A version-8
 *  UUID never equals a CLI session id (version 4), and the tag lets the
 *  transcript writer recognize the bridge's own left-behind files without
 *  reading them. The CLI sends the id in every request header, so the tag
 *  bytes spell no name. */
const SESSION_TAG = Buffer.from("9d3b72e1", "hex");
/** The tag that builds before 2026-10-09 put in their ids. A crash can leave
 *  a transcript with it behind, so the transcript writer still recognizes it.
 *  Remove it and its test after 2027-01-09, by which time every such
 *  transcript is gone. */
const EARLIER_SESSION_TAG = "464c5957";
const BRIDGE_SESSION_ID = new RegExp(`^(?:${SESSION_TAG.toString("hex")}|${EARLIER_SESSION_TAG})-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "u");

/** A new bridge session id: a random version-8 UUID with the tag. A bridge with a lifetime mints one and keeps it
 *  for every query, so its rotations resume the same CLI session; a bridge without one mints one for each query.
 *  Two bridges never share an id, even when they serve one conversation key (a rebuilt client, a learning review,
 *  or the included and the paid route of one account), because the CLI finds a rotation transcript by the id. */
export function bridgeSessionId(): string {
  const bytes = randomBytes(16);
  SESSION_TAG.copy(bytes, 0);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether an id is a bridge session id. The transcript sweep deletes only these, so it never touches the CLI's
 *  own sessions in a config directory that the person also uses. */
export function isBridgeSessionId(id: string): boolean {
  return BRIDGE_SESSION_ID.test(id);
}
