import { RELAY_PROTOCOL_VERSION } from "../src/protocol/modules/remote/relay-protocol.js"

/** Reads the relay protocol version the hosted relay speaks.
 *
 *  With no argument it requires the live relay to speak this tree's version:
 *  a deploy runs it after the Worker goes out, and `bun run release` runs it
 *  before it builds, so no binary is published that the hosted relay would
 *  refuse. With `--before-deploy` it guards the deploy itself: a tree whose
 *  version is older than the live relay's would turn every runtime that
 *  already speaks the newer version away, so the deploy stops. A relay that
 *  does not answer is no reason to stop a deploy, which may be what repairs
 *  it. */

const HEALTH_URL = "https://relay.flywl.sh/health"
const beforeDeploy = process.argv.includes("--before-deploy")

async function liveVersion(): Promise<number> {
  const response = await fetch(HEALTH_URL)
  if (!response.ok) throw new Error(`Relay health probe failed with HTTP ${response.status}`)
  const health: unknown = await response.json()
  if (typeof health !== "object" || health === null || !("ok" in health) || health.ok !== true || !("relayProtocolVersion" in health) || typeof health.relayProtocolVersion !== "number") {
    throw new Error("Relay health probe got no relay protocol version")
  }
  return health.relayProtocolVersion
}

if (beforeDeploy) {
  const live = await liveVersion().catch((error: unknown) => {
    console.warn(`Could not read the live relay protocol version, deploying anyway: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  if (live !== undefined && live > RELAY_PROTOCOL_VERSION) {
    throw new Error(`The live relay speaks relay protocol ${live} and this tree speaks ${RELAY_PROTOCOL_VERSION}; deploying it would refuse every runtime on ${live}. Deploy from a tree at ${live} or later.`)
  }
} else {
  const live = await liveVersion()
  if (live !== RELAY_PROTOCOL_VERSION) throw new Error(`Relay health probe expected protocol version ${RELAY_PROTOCOL_VERSION}, and the live relay speaks ${live}`)
  console.log(`Relay protocol version ${RELAY_PROTOCOL_VERSION} is live`)
}
