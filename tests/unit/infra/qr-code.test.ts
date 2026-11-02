import { describe, expect, test } from "bun:test"

import { qrCodeHeight, qrCodeRows, qrCodeWidth } from "../../../src/infra/qr-code.js"

/** The pairing code has to fit a terminal and read as a QR code, so the rows
 *  are held to a width a phone-scannable code of a hosted pairing URL needs. */
describe("terminal QR rendering", () => {
  const url = `https://remote.flywl.sh/#p=1.${"A".repeat(43)}.abcdefghijkl.abcdefghijklmnopqrstuv.m2b3c4d5.Zmx5d2hlZWw`

  test("renders two module rows per text row with a quiet zone", () => {
    const rows = qrCodeRows(url)
    const width = qrCodeWidth(url)
    expect(width).toBeLessThanOrEqual(48)
    expect(rows.length).toBe(Math.ceil(width / 2))
    expect(qrCodeHeight(url)).toBe(rows.length)
    for (const row of rows) expect(row.length).toBe(width)
    // The quiet zone is blank on every edge.
    expect(rows[0]!.startsWith(" ")).toBe(true)
    expect(rows.every((row) => row.endsWith(" "))).toBe(true)
    expect(rows.some((row) => row.includes("█"))).toBe(true)
  })
})
