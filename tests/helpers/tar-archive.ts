/** A tar archive written block by block, so a test can state any entry a
 *  publisher might ship: any typeflag, a link target, a pax record, and a
 *  header size its content does not hold. */

export interface TarEntrySpec {
  readonly name: string;
  /** Any tar typeflag: `0` file, `5` directory, `1` hard link, `2` symbolic
   *  link, `x` pax header, `L` GNU long name. */
  readonly typeflag: string;
  readonly mode: number;
  readonly content?: string | Uint8Array;
  readonly linkname?: string;
  /** The size the header states, when a publisher states one its content does
   *  not hold. */
  readonly statedSize?: number;
}

/** Pax records, each `"<length> <key>=<value>\n"` with the length counting
 *  the whole record. */
export function paxRecords(records: { readonly [key: string]: string }): string {
  return Object.entries(records).map(([key, value]) => {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length += 1;
    return `${length}${body}`;
  }).join("");
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

export function tarBlocks(entries: readonly TarEntrySpec[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = typeof entry.content === "string" ? new TextEncoder().encode(entry.content) : entry.content ?? new Uint8Array(0);
    const header = new Uint8Array(512);
    const put = (text: string, offset: number): void => { header.set(new TextEncoder().encode(text), offset); };
    put(entry.name, 0);
    put(octal(entry.mode, 8), 100);
    put(octal(0, 8), 108);
    put(octal(0, 8), 116);
    put(octal(entry.statedSize ?? data.byteLength, 12), 124);
    put(octal(0, 12), 136);
    put("        ", 148);
    put(entry.typeflag, 156);
    put(entry.linkname ?? "", 157);
    put("ustar\x0000", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    if (data.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((size, block) => size + block.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  return tar;
}
