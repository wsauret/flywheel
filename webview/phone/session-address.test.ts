import { expect, test } from "bun:test"

import { restoreSessionAddress, takeSessionAddress } from "./session-address.js"

function page(hash: string) {
  const replaced: { readonly state: unknown; readonly url: string | URL | null | undefined }[] = []
  const state = { flywheelScreen: "sessions" }
  return {
    replaced,
    location: { hash, pathname: "/" },
    history: { state, replaceState: (next: unknown, _unused: string, url?: string | URL | null) => { replaced.push({ state: next, url }) } },
  }
}

test("a notification's address names its session once, and the fragment goes with the state kept", () => {
  const tapped = page(`#session=${encodeURIComponent("ses_a/b")}`)
  expect(takeSessionAddress(tapped)).toEqual({ sessionId: "ses_a/b", attention: false })
  expect(tapped.replaced).toEqual([{ state: { flywheelScreen: "sessions" }, url: "/" }])
})

test("a question notification carries the machine, project, session, and attention action", () => {
  const tapped = page("#runtime=studio&placement=project&session=chat&attention=question")
  const address = takeSessionAddress(tapped)!
  expect(address).toEqual({ sessionId: "chat", selection: { runtimeId: "studio", placementId: "project" }, attention: true })
  restoreSessionAddress(tapped, address)
  const reloaded = page(new URL(String(tapped.replaced.at(-1)?.url), "https://phone.test").hash)
  expect(takeSessionAddress(reloaded)).toEqual(address)
})

test("a pairing fragment or no fragment names no session and stays for its own reader", () => {
  for (const hash of ["#p=1.relay.key", ""]) {
    const other = page(hash)
    expect(takeSessionAddress(other)).toBeUndefined()
    expect(other.replaced).toEqual([])
  }
})
