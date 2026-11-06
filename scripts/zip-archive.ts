/** A deterministic zip writer for release assets. Bun's archive API writes only tar, and a consumer that installs
 *  from a zip refuses tar data, so release assets that must be zips use this. Every entry is deflated, dated
 *  1980-01-01, and stored as a regular file with mode 0644, so the same files always give the same bytes and the
 *  same digest. */

import { crc32, deflateRawSync } from "node:zlib";

const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const UNIX_REGULAR_FILE_0644 = 0o100644;

/** The zip archive of `files`, keyed by forward-slash relative path, in the order given. */
export function zipArchive(files: ReadonlyMap<string, string>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of files) {
    const name = Buffer.from(path, "utf8");
    const data = Buffer.from(text, "utf8");
    const deflated = deflateRawSync(data);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(deflated.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((UNIX_REGULAR_FILE_0644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + deflated.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
