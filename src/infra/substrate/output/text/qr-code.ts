import QRCode from "qrcode"

const QUIET_ZONE = 1

interface Modules {
  readonly size: number
  readonly data: ArrayLike<boolean | number>
}

function dark(modules: Modules, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= modules.size || y >= modules.size) return false
  return Boolean(modules.data[y * modules.size + x])
}

function halfBlock(top: boolean, bottom: boolean): string {
  if (top && bottom) return "█"
  if (top) return "▀"
  if (bottom) return "▄"
  return " "
}

function modulesFor(text: string): Modules {
  return QRCode.create(text, { errorCorrectionLevel: "L" }).modules
}

/** A QR code as half-block glyph rows, with a one-module quiet zone. */
export function qrCodeRows(text: string): readonly string[] {
  const modules = modulesFor(text)
  const rows: string[] = []
  for (let y = -QUIET_ZONE; y < modules.size + QUIET_ZONE; y += 2) {
    let row = ""
    for (let x = -QUIET_ZONE; x < modules.size + QUIET_ZONE; x += 1) row += halfBlock(dark(modules, x, y), dark(modules, x, y + 1))
    rows.push(row)
  }
  return rows
}

/** Terminal columns a code for `text` occupies. */
export function qrCodeWidth(text: string): number {
  return modulesFor(text).size + QUIET_ZONE * 2
}

/** Terminal rows a code for `text` occupies: two module rows per text row. */
export function qrCodeHeight(text: string): number {
  return Math.ceil(qrCodeWidth(text) / 2)
}
