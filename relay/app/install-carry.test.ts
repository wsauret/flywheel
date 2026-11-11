import { expect, test } from "bun:test"
import { join } from "node:path"

import { brandTileSvg } from "../../src/protocol/client/brand.js"
import type { DeviceStore, PairedRuntime } from "../../src/protocol/modules/remote/relay-device.js"
import { installManifestHref, readInstallCarry } from "./install-carry.js"

const ORIGIN = "https://remote.flywl.sh"
const STRANDS = "iOS records this at Add to Home Screen and never reads it again, so a change strands every installed app (ARCH-PROTOCOL-070)"
const DESK: PairedRuntime = { runtimeId: "desk", publicKey: "key-desk", relay: "wss://relay.flywl.sh", label: "Desk", pairedAt: 1 }

async function store(input: { readonly extractable: boolean; readonly runtimes: readonly PairedRuntime[] }): Promise<DeviceStore> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, input.extractable, ["sign", "verify"])
  if (!("privateKey" in keyPair)) throw new Error("expected an asymmetric key pair")
  return {
    device: { keyPair, deviceId: "phone", publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)) },
    label: () => "iPhone",
    setLabel: async () => {},
    runtimes: async () => input.runtimes,
    putRuntime: async () => {},
    removeRuntime: async () => {},
    selection: async () => undefined,
    setSelection: async () => {},
  }
}

async function manifestOf(subject: DeviceStore): Promise<{ readonly start_url: string; readonly [field: string]: unknown }> {
  const href = await installManifestHref(ORIGIN, subject)
  expect(href.startsWith("data:application/manifest+json,")).toBe(true)
  return JSON.parse(decodeURIComponent(href.slice(href.indexOf(",") + 1)))
}

test("the manifest the page builds keeps every install-time field unchanged across releases", async () => {
  const { start_url: _start, ...installed } = await manifestOf(await store({ extractable: true, runtimes: [DESK] }))
  expect(installed, `The manifest changed. ${STRANDS}.`).toEqual({
    id: `${ORIGIN}/`,
    name: "Flywheel",
    short_name: "Flywheel",
    description: "Your Flywheel sessions, from your phone.",
    scope: `${ORIGIN}/`,
    display: "standalone",
    background_color: "#1c1b19",
    theme_color: "#1c1b19",
    icons: [
      { src: `${ORIGIN}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: `${ORIGIN}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  })
})

test("the page's home-screen head tags stay unchanged across releases, and the manifest link is the page's own", async () => {
  const head = (await Bun.file(join(import.meta.dir, "index.html")).text()).split("</head>")[0] ?? ""
  const tags = [...head.matchAll(/<(?:meta|link)\b[^>]*>/g)].map((match) => match[0]).filter((tag) => !tag.includes("stylesheet"))
  expect(tags, `A home-screen head tag changed. ${STRANDS}. The manifest link is inserted by the bootstrap, which builds its start URL.`).toEqual([
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf9f7">`,
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1b19">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-title" content="Flywheel">`,
    `<link rel="icon" href="/icon-192.png" type="image/png">`,
    `<link rel="apple-touch-icon" href="/icon-180.png">`,
  ])
})

// The drawing the build rasterises, not its pixels: the rasteriser's
// antialiasing differs between the platforms CI runs on.
test("the Home Screen icons the build draws stay unchanged across releases", () => {
  const drawn = [180, 192, 512].map((size) => new Bun.CryptoHasher("sha256").update(brandTileSvg(size, { corners: "square" })).digest("hex"))
  expect(drawn, `An icon changed. ${STRANDS}.`).toEqual([
    "cbf0a46c661bb7d105002b189266c855e3345e53ef80d6bc02e87334f95c52ef",
    "29a79fcb9b7695502ccc1e002ae6d184f798ec1005df8c0b177678807b9c8b7c",
    "9957db1e85943ec741e61af192ac9ab02ff87458f58b070fcd28bec6c8468eb9",
  ])
})

test("a browser with nothing to carry installs an app that starts at the root", async () => {
  // No machine yet, and a key made before keys were exportable.
  expect((await manifestOf(await store({ extractable: true, runtimes: [] }))).start_url).toBe(`${ORIGIN}/`)
  expect((await manifestOf(await store({ extractable: false, runtimes: [DESK] }))).start_url).toBe(`${ORIGIN}/`)
})

test("a fragment that is not a well-formed carry carries nothing", async () => {
  const fragment = new URL((await manifestOf(await store({ extractable: true, runtimes: [DESK] }))).start_url).hash
  expect(await readInstallCarry(fragment)).toBeDefined()
  for (const malformed of ["#install=", "#install=not-base64!", `#install=${btoa("{}")}`, `${fragment.slice(0, -8)}`, "#p=code", "#session=chat"]) {
    expect(await readInstallCarry(malformed)).toBeUndefined()
  }
})
