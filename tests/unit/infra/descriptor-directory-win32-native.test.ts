import { describe, expect, it } from "bun:test";
import { type Pointer, ptr, toArrayBuffer } from "bun:ffi";

import {
  type Advapi32FileSymbols,
  createWin32NativeDirectoryApi,
  encodeComponentName,
  encodeWidePath,
  fileInformationFrom,
  type Kernel32FileSymbols,
  MAX_COMPONENT_UNITS,
  type NativeWindowsFileSnapshot,
  type NtdllFileSymbols,
  objectAttributesFor,
  openNativeWindowsDirectory,
  renameInformationFor,
  unicodeStringFor,
  WIN32_LAYOUT,
} from "../../../src/infra/descriptor-directory-win32-native.js";

// Windows x64 and arm64 are both little-endian LLP64: one layout, checked as literal bytes.
const ROOT_HANDLE = 0x0000_0000_0000_01c4n;
const NAME_ADDRESS = 0x0000_7ff6_1234_5678n;

describe("win32 structure layouts", () => {
  it("lays out UNICODE_STRING as two u16 lengths, padding, and a pointer", () => {
    const name = encodeComponentName("ab");
    expect(Buffer.from(unicodeStringFor(name, NAME_ADDRESS))).toEqual(Buffer.from([
      0x04, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x78, 0x56, 0x34, 0x12, 0xf6, 0x7f, 0x00, 0x00,
    ]));
    expect(WIN32_LAYOUT.unicodeString).toEqual({ size: 16, length: 0, maximumLength: 2, buffer: 8 });
  });

  it("lays out OBJECT_ATTRIBUTES with the root handle and the case-insensitive flag", () => {
    expect(Buffer.from(objectAttributesFor(ROOT_HANDLE, NAME_ADDRESS))).toEqual(Buffer.from([
      0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xc4, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x78, 0x56, 0x34, 0x12, 0xf6, 0x7f, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]));
    expect(WIN32_LAYOUT.objectAttributes.size).toBe(48);
    expect(WIN32_LAYOUT.ioStatusBlock).toEqual({ size: 16, status: 0, information: 8 });
  });

  it("lays out FILE_RENAME_INFO with the name inline after a 20-byte header", () => {
    expect(Buffer.from(renameInformationFor(ROOT_HANDLE, encodeComponentName("b.txt")))).toEqual(Buffer.from([
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xc4, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x0a, 0x00, 0x00, 0x00,
      0x62, 0x00, 0x2e, 0x00, 0x74, 0x00, 0x78, 0x00, 0x74, 0x00,
    ]));
    expect(WIN32_LAYOUT.fileRenameInformation).toEqual({ replaceIfExists: 0, rootDirectory: 8, fileNameLength: 16, fileName: 20 });
    expect(renameInformationFor(0n, encodeComponentName("a"))).toHaveLength(24);
    expect(WIN32_LAYOUT.fileDispositionInformation).toEqual({ size: 1, deleteFile: 0 });
  });

  it("reads BY_HANDLE_FILE_INFORMATION fields at their 4-byte offsets", () => {
    const buffer = new Uint8Array(WIN32_LAYOUT.byHandleFileInformation.size);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, 0x400, true);
    view.setUint32(28, 7, true);
    view.setUint32(32, 1, true);
    view.setUint32(36, 5, true);
    view.setUint32(40, 2, true);
    view.setUint32(44, 0x1000, true);
    view.setUint32(48, 0x2000, true);
    expect(fileInformationFrom(buffer)).toEqual({ attributes: 0x400, volumeSerial: 7, size: 0x1_0000_0005, links: 2, indexHigh: 0x1000, indexLow: 0x2000 });
    expect(WIN32_LAYOUT.byHandleFileInformation.size).toBe(52);
    expect(WIN32_LAYOUT.fileFsDeviceInformation).toEqual({ size: 8, deviceType: 0, characteristics: 4 });
    expect(WIN32_LAYOUT.fileFsAttributeInformation).toEqual({ size: 76, attributes: 0, maximumComponentNameLength: 4, filesystemNameLength: 8, filesystemName: 12 });
    expect(WIN32_LAYOUT.aclHeader).toEqual({ size: 8, revision: 0, aclSize: 2, aceCount: 4 });
  });
});

describe("win32 wide-string encoding", () => {
  it("encodes one component as UTF-16LE without a terminator and a path with one", () => {
    expect(Buffer.from(encodeComponentName("aé😀"))).toEqual(Buffer.from([0x61, 0x00, 0xe9, 0x00, 0x3d, 0xd8, 0x00, 0xde]));
    expect(Buffer.from(encodeWidePath("C:\\x"))).toEqual(Buffer.from([0x43, 0x00, 0x3a, 0x00, 0x5c, 0x00, 0x78, 0x00, 0x00, 0x00]));
  });

  it("refuses names that are not one component and names over the u16 byte bound", () => {
    for (const invalid of ["", ".", "..", "a/b", "a\\b", "c:stream", "nul\0"]) {
      expect(() => encodeComponentName(invalid)).toThrow("one Windows path component");
    }
    expect(encodeComponentName("x".repeat(MAX_COMPONENT_UNITS)).byteLength).toBe(MAX_COMPONENT_UNITS * 2);
    expect(() => encodeComponentName("x".repeat(MAX_COMPONENT_UNITS + 1))).toThrow("at most 32767 UTF-16 units");
  });
});

/** A scripted stand-in for the three system libraries. Each open handle is the address of a
 *  live buffer, so every value that crosses the boundary is a real pointer-sized integer. */
interface FakeFile {
  content: Buffer;
  identity: number;
  links: number;
  dacl: Buffer;
  reparse?: boolean;
  directory?: boolean;
}

function fakeLibraries(files: Map<string, FakeFile>, script: { readonly remote?: boolean; readonly filesystem?: string; readonly failRename?: boolean; readonly failFlush?: boolean; readonly failInstalledOpen?: boolean; readonly maxTransferBytes?: number; readonly installedChange?: Partial<FakeFile>; readonly directoryPages?: readonly Buffer[]; readonly enumerationError?: number } = {}) {
  const calls: string[] = [];
  const opens: { root: bigint; name: string; access: number; options: number }[] = [];
  const renames: { root: bigint; handle: bigint; target: string }[] = [];
  const ioCalls: { readonly operation: "read" | "write"; readonly handle: bigint; readonly name: string; readonly access: number; readonly cursor: number }[] = [];
  const handles = new Map<bigint, { readonly file: FakeFile; readonly name: string; readonly access: number; cursor: number }>();
  const directoryQueries: { handle: bigint; informationClass: number }[] = [];
  const directoryCursors = new Map<bigint, number>();
  const anchors: Uint8Array[] = [];
  let nextIdentity = 100;
  let lastError = 0;
  const openHandle = (name: string, file: FakeFile, access: number): bigint => {
    const anchor = new Uint8Array(8);
    anchors.push(anchor);
    const handle = BigInt(ptr(anchor));
    handles.set(handle, { file, name, access, cursor: 0 });
    return handle;
  };
  const rootFile: FakeFile = { content: Buffer.alloc(0), identity: 1, links: 1, dacl: Buffer.alloc(0), directory: true };
  const held = (handle: bigint) => {
    const entry = handles.get(handle);
    if (!entry) throw new Error(`unknown handle ${handle}`);
    return entry;
  };
  const readUnicode = (attributesAddress: Pointer): string => {
    const attributes = new DataView(toArrayBuffer(attributesAddress, 0, WIN32_LAYOUT.objectAttributes.size));
    expect(attributes.getUint32(0, true)).toBe(48);
    expect(attributes.getUint32(24, true)).toBe(0x40);
    // SAFETY: the scripted library reads back a pointer this test's subject wrote.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a raw address read from a structure cannot carry Bun's Pointer tag, which only ptr() produces
    const unicode = new DataView(toArrayBuffer(Number(attributes.getBigUint64(16, true)) as Pointer, 0, 16));
    const length = unicode.getUint16(0, true);
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a raw address read from a structure cannot carry Bun's Pointer tag, which only ptr() produces
    return Buffer.from(toArrayBuffer(Number(unicode.getBigUint64(8, true)) as Pointer, 0, length)).toString("utf16le");
  };
  const kernel32: Kernel32FileSymbols = {
    CreateFileW: (name, access, _share, _security, _creation, flags) => {
      const path = Buffer.from(toArrayBuffer(name, 0, 2 * 3)).toString("utf16le");
      calls.push(`CreateFileW:${path}:${flags.toString(16)}`);
      return openHandle("<root>", rootFile, access);
    },
    CloseHandle: (handle) => {
      calls.push(`CloseHandle:${held(handle).name}`);
      handles.delete(handle);
      return 1;
    },
    GetLastError: () => lastError,
    GetFileInformationByHandleEx: (handle, informationClass, information, length) => {
      directoryQueries.push({ handle, informationClass });
      if ((held(handle).access & 1) === 0 || script.enumerationError !== undefined) {
        lastError = script.enumerationError ?? 5;
        return 0;
      }
      if (informationClass === 11) directoryCursors.set(handle, 0);
      else expect(informationClass).toBe(10);
      const index = directoryCursors.get(handle) ?? 0;
      const page = script.directoryPages?.[index];
      if (page === undefined) {
        lastError = 18;
        return 0;
      }
      expect(page.byteLength).toBeLessThanOrEqual(length);
      new Uint8Array(toArrayBuffer(information, 0, length)).set(page);
      directoryCursors.set(handle, index + 1);
      return 1;
    },
    GetFileInformationByHandle: (handle, information) => {
      const { file } = held(handle);
      const view = new DataView(toArrayBuffer(information, 0, WIN32_LAYOUT.byHandleFileInformation.size));
      view.setUint32(0, file.reparse ? 0x400 : 0, true);
      view.setUint32(28, 7, true);
      view.setUint32(36, file.content.byteLength, true);
      view.setUint32(40, file.links, true);
      view.setUint32(48, file.identity, true);
      return 1;
    },
    ReadFile: (handle, buffer, bytes, read) => {
      const entry = held(handle);
      ioCalls.push({ operation: "read", handle, name: entry.name, access: entry.access, cursor: entry.cursor });
      new Uint32Array(toArrayBuffer(read, 0, 4))[0] = 0;
      if ((entry.access & 0x8000_0001) === 0) {
        lastError = 5;
        return 0;
      }
      const target = new Uint8Array(toArrayBuffer(buffer, 0, bytes));
      const count = Math.min(bytes, entry.file.content.byteLength - entry.cursor, script.maxTransferBytes ?? bytes);
      target.set(entry.file.content.subarray(entry.cursor, entry.cursor + count));
      entry.cursor += count;
      new Uint32Array(toArrayBuffer(read, 0, 4))[0] = count;
      return 1;
    },
    WriteFile: (handle, buffer, bytes, written) => {
      const entry = held(handle);
      ioCalls.push({ operation: "write", handle, name: entry.name, access: entry.access, cursor: entry.cursor });
      new Uint32Array(toArrayBuffer(written, 0, 4))[0] = 0;
      if ((entry.access & 0x4000_0002) === 0) {
        lastError = 5;
        return 0;
      }
      const count = Math.min(bytes, script.maxTransferBytes ?? bytes);
      const content = Buffer.alloc(Math.max(entry.file.content.byteLength, entry.cursor + count));
      entry.file.content.copy(content);
      content.set(new Uint8Array(toArrayBuffer(buffer, 0, count)), entry.cursor);
      entry.file.content = content;
      entry.cursor += count;
      new Uint32Array(toArrayBuffer(written, 0, 4))[0] = count;
      return 1;
    },
    FlushFileBuffers: (handle) => {
      calls.push(`FlushFileBuffers:${held(handle).name}`);
      if (script.failFlush) {
        lastError = 1117;
        return 0;
      }
      return 1;
    },
    LocalFree: (memory) => {
      calls.push(`LocalFree:${memory}`);
      return 0n;
    },
  };
  const descriptors: Uint8Array[] = [];
  const ntdll: NtdllFileSymbols = {
    NtCreateFile: (handleOut, access, attributes, _status, _allocation, _fileAttributes, _share, disposition, options) => {
      const name = readUnicode(attributes);
      opens.push({ root: new DataView(toArrayBuffer(attributes, 0, 48)).getBigUint64(8, true), name, access, options });
      const directory = (options & 0x01) !== 0;
      calls.push(`NtCreateFile:${name}:${disposition}:${directory ? "dir" : "file"}`);
      let file = files.get(name);
      if (file === undefined) {
        if (disposition === 1) return 0xc0000034 - 0x1_0000_0000;
        if (script.failInstalledOpen && name === "installed-fails") return 0xc0000022 - 0x1_0000_0000;
        file = { content: Buffer.alloc(0), identity: nextIdentity++, links: 1, dacl: Buffer.from([2, 0, 8, 0, 0, 0, 0, 0]), directory };
        files.set(name, file);
      } else if (disposition === 2) return 0xc0000035 - 0x1_0000_0000;
      if (script.failInstalledOpen && name === "installed-fails" && disposition === 1) return 0xc0000022 - 0x1_0000_0000;
      new BigUint64Array(toArrayBuffer(handleOut, 0, 8))[0] = openHandle(name, file, access);
      return 0;
    },
    NtQueryVolumeInformationFile: (_handle, _status, information, length, informationClass) => {
      const view = new DataView(toArrayBuffer(information, 0, length));
      if (informationClass === 4) view.setUint32(4, script.remote ? 0x10 : 0, true);
      else {
        const name = Buffer.from(script.filesystem ?? "NTFS", "utf16le");
        view.setUint32(8, name.byteLength, true);
        new Uint8Array(toArrayBuffer(information, 12, name.byteLength)).set(name);
      }
      return 0;
    },
    NtSetInformationFile: (handle, _status, information, size, informationClass) => {
      const entry = held(handle);
      if (informationClass === 13) {
        expect(size).toBe(1);
        expect(new Uint8Array(toArrayBuffer(information, 0, 1))[0]).toBe(1);
        calls.push(`delete:${entry.name}`);
        files.delete(entry.name);
        return 0;
      }
      expect(informationClass).toBe(10);
      const view = new DataView(toArrayBuffer(information, 0, size));
      expect(view.getUint8(0)).toBe(1);
      const nameBytes = view.getUint32(16, true);
      const target = Buffer.from(new Uint8Array(toArrayBuffer(information, 20, nameBytes))).toString("utf16le");
      renames.push({ root: view.getBigUint64(8, true), handle, target });
      calls.push(`rename:${entry.name}->${target}`);
      if (script.failRename) return 0xc0000043 - 0x1_0000_0000;
      files.delete(entry.name);
      files.set(target, entry.file);
      if (script.installedChange !== undefined) Object.assign(entry.file, script.installedChange);
      return 0;
    },
  };
  const advapi32: Advapi32FileSymbols = {
    GetSecurityInfo: (handle, _objectType, _information, _owner, _group, dacl, _sacl, descriptor) => {
      const { file } = held(handle);
      if (file.dacl.byteLength === 0) {
        new BigUint64Array(toArrayBuffer(dacl, 0, 8))[0] = 0n;
        new BigUint64Array(toArrayBuffer(descriptor, 0, 8))[0] = 0x51n;
        return 0;
      }
      const copy = new Uint8Array(file.dacl);
      descriptors.push(copy);
      new BigUint64Array(toArrayBuffer(dacl, 0, 8))[0] = BigInt(ptr(copy));
      new BigUint64Array(toArrayBuffer(descriptor, 0, 8))[0] = 0x51n;
      return 0;
    },
    SetSecurityInfo: (handle, _objectType, _information, _owner, _group, dacl) => {
      const { file } = held(handle);
      const size = new DataView(toArrayBuffer(dacl, 0, 8)).getUint16(2, true);
      file.dacl = Buffer.from(new Uint8Array(toArrayBuffer(dacl, 0, size)));
      calls.push(`SetSecurityInfo:${size}`);
      return 0;
    },
  };
  return { api: createWin32NativeDirectoryApi({ kernel32, ntdll, advapi32 }), calls, ioCalls, handles, files, opens, renames, directoryQueries };
}

const ACL = Buffer.from([2, 0, 8, 0, 0, 0, 0, 0]);

function snapshotOf(file: FakeFile, identity = file.identity): NativeWindowsFileSnapshot {
  return { content: Buffer.from(file.content), identity: `7:00000000${identity.toString(16).padStart(8, "0")}`, linkCount: file.links, dacl: Buffer.from(file.dacl) };
}

describe("win32 native directory authority over scripted libraries", () => {
  it("enumerates pages from the retained handle, restarts each scan, and decodes names, kinds, and times", () => {
    // FILE_ID_BOTH_DIR_INFO records from the Windows boundary, including aligned padding between records.
    const page = Buffer.alloc(376);
    for (const [offset, next, name, attributes, created, updated] of [
      [0, 112, ".", 0x10, 0, 0],
      [112, 120, "..", 0x10, 0, 0],
      [232, 0, "é😀.txt", 0x20, 100, 200],
    ] satisfies [number, number, string, number, number, number][]) {
      page.writeUInt32LE(next, offset);
      page.writeBigInt64LE(116444736000000000n + BigInt(created) * 10000n, offset + 8);
      page.writeBigInt64LE(116444736000000000n + BigInt(updated) * 10000n, offset + 24);
      page.writeUInt32LE(attributes, offset + 56);
      page.writeUInt32LE(Buffer.byteLength(name, "utf16le"), offset + 60);
      page.write(name, offset + 104, "utf16le");
    }
    const second = Buffer.alloc(240);
    second.writeUInt32LE(120, 0);
    second.writeUInt32LE(0x10, 56);
    second.writeUInt32LE(10, 60);
    second.write("child", 104, "utf16le");
    second.writeUInt32LE(0x410, 120 + 56);
    second.writeUInt32LE(8, 120 + 60);
    second.write("link", 120 + 104, "utf16le");
    const { api, handles, directoryQueries } = fakeLibraries(new Map(), { directoryPages: [page, second] });
    const directory = api.open("C:\\", [], false);
    const [handle] = handles.keys();
    if (handle === undefined) throw new Error("directory handle must be open");
    try {
      for (let scan = 0; scan < 2; scan++) {
        const entries = directory.entries();
        expect(entries).toHaveLength(3);
        expect(entries[0]).toEqual({ name: "é😀.txt", kind: "file", createdAt: 100, updatedAt: 200 });
        expect(entries[1]).toMatchObject({ name: "child", kind: "directory" });
        expect(entries[2]).toMatchObject({ name: "link", kind: "reparse" });
      }
      expect(directoryQueries).toEqual([11, 10, 10, 11, 10, 10].map((informationClass) => ({ handle, informationClass })));
    } finally {
      directory.close();
    }
    expect(() => directory.entries()).toThrow("directory is closed");
    expect(handles.size).toBe(0);
  });

  it("returns an empty enumeration at end of directory and propagates other native errors", () => {
    const empty = fakeLibraries(new Map()).api.open("C:\\", [], false);
    const denied = fakeLibraries(new Map(), { enumerationError: 5 }).api.open("C:\\", [], false);
    try {
      expect(empty.entries()).toEqual([]);
      expect(() => denied.entries()).toThrow("GetFileInformationByHandleEx(directory) failed with Win32 error 5");
    } finally {
      empty.close();
      denied.close();
    }
  });

  it.each([false, true])("renames an entry through both retained parents (directory=%s)", (directory) => {
    const file: FakeFile = { content: Buffer.from("kept"), identity: 5, links: 1, dacl: ACL, directory };
    const { api, handles, opens, renames, calls } = fakeLibraries(new Map([["entry", file]]));
    const source = api.open("C:\\", [], false);
    const target = api.open("D:\\", [], false);
    const [sourceHandle, targetHandle] = handles.keys();
    if (sourceHandle === undefined || targetHandle === undefined) throw new Error("both directory handles must be open");
    source.renameInto("entry", target, "moved");
    expect(opens).toEqual([{ root: sourceHandle, name: "entry", access: 0x0011_0080, options: 0x0020_0020 }]);
    expect(renames).toEqual([{ root: targetHandle, handle: expect.any(BigInt), target: "moved" }]);
    expect(calls).toContain("CloseHandle:entry");
    expect(handles.size).toBe(2);
    target.close();
    expect(() => source.renameInto("moved", target, "other")).toThrow("directory is closed");
    source.close();
    expect(handles.size).toBe(0);
  });

  it("rejects absent, reparse, invalid, and foreign rename sources without leaking handles", () => {
    const { api, handles, renames } = fakeLibraries(new Map([
      ["link", { content: Buffer.alloc(0), identity: 5, links: 1, dacl: ACL, reparse: true }],
    ]));
    const source = api.open("C:\\", [], false);
    expect(() => source.renameInto("missing", source, "target")).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => source.renameInto("link", source, "target")).toThrow(expect.objectContaining({ code: "ELOOP" }));
    expect(() => source.renameInto("../entry", source, "target")).toThrow("one path component");
    expect(() => source.renameInto("entry", source, "../target")).toThrow("one path component");
    const foreign = fakeLibraries(new Map()).api.open("C:\\", [], false);
    expect(() => source.renameInto("entry", foreign, "target")).toThrow("same native backend");
    foreign.close();
    expect(renames).toEqual([]);
    expect(handles.size).toBe(1);
    source.close();
    expect(handles.size).toBe(0);
  });

  it("closes the source entry when the native rename fails", () => {
    const { api, handles, calls } = fakeLibraries(new Map([
      ["entry", { content: Buffer.from("kept"), identity: 5, links: 1, dacl: ACL }],
    ]), { failRename: true });
    const source = api.open("C:\\", [], false);
    expect(() => source.renameInto("entry", source, "target")).toThrow("NtSetInformationFile(rename)");
    expect(calls).toContain("CloseHandle:entry");
    expect(handles.size).toBe(1);
    source.close();
  });

  it("opens the base by path, walks components by handle, and reports handle identity", () => {
    const files = new Map<string, FakeFile>([["sub", { content: Buffer.alloc(0), identity: 9, links: 1, dacl: ACL, directory: true }]]);
    const { api, calls, handles } = fakeLibraries(files);
    const directory = api.open("C:\\", ["sub"], true);
    expect(directory.identity()).toBe("7:0000000000000009");
    expect(calls).toEqual(["CreateFileW:C:\\:2200000", "NtCreateFile:sub:1:dir", "CloseHandle:<root>"]);
    directory.close();
    directory.close();
    expect(handles.size).toBe(0);
    expect(() => directory.identity()).toThrow("directory is closed");
  });

  it("refuses remote volumes, unsupported filesystems, and reparse points", () => {
    expect(() => fakeLibraries(new Map(), { remote: true }).api.open("C:\\", [], false)).toThrow("remote filesystems are not supported");
    expect(() => fakeLibraries(new Map(), { filesystem: "FAT32" }).api.open("C:\\", [], false)).toThrow("filesystem FAT32 is not supported");
    const files = new Map<string, FakeFile>([["link", { content: Buffer.alloc(0), identity: 3, links: 1, dacl: ACL, reparse: true, directory: true }]]);
    const { api, handles } = fakeLibraries(files);
    expect(() => api.open("C:\\", ["link"], false)).toThrow("a reparse point is not a contained entry");
    expect(handles.size).toBe(0);
  });

  it("reads a snapshot with its DACL, frees the descriptor, and treats absence and null DACLs distinctly", () => {
    const files = new Map<string, FakeFile>([
      ["a.txt", { content: Buffer.from("hello"), identity: 5, links: 2, dacl: ACL }],
      ["open.txt", { content: Buffer.from("x"), identity: 6, links: 1, dacl: Buffer.alloc(0) }],
    ]);
    const { api, calls } = fakeLibraries(files);
    const directory = api.open("C:\\", [], false);
    expect(directory.readFileSnapshot("a.txt", 16)).toEqual({ content: Buffer.from("hello"), identity: "7:0000000000000005", linkCount: 2, dacl: ACL });
    expect(calls).toContain("LocalFree:81");
    expect(directory.readFileSnapshot("missing.txt", 16)).toBeUndefined();
    expect(() => directory.readFileSnapshot("a.txt", 4)).toThrow("file exceeds its 4-byte read limit");
    expect(() => directory.readFileSnapshot("open.txt", 16)).toThrow("a null DACL is not admissible");
    expect(directory.openChild("missing", false)).toBeUndefined();
    expect(directory.openChild("made", true)?.identity()).toMatch(/^7:/);
  });

  it("publishes only while the target still matches, applies the DACL, and verifies the installed file", () => {
    const target: FakeFile = { content: Buffer.from("old"), identity: 5, links: 1, dacl: ACL };
    const files = new Map<string, FakeFile>([["a.txt", target]]);
    const { api, calls, handles } = fakeLibraries(files);
    const directory = api.open("C:\\", [], false);
    const published = directory.publishFileBytes(".pending", "a.txt", Buffer.from("new bytes"), snapshotOf(target), ACL);
    expect(published).toEqual({ status: "published" });
    expect(files.get("a.txt")?.content.toString()).toBe("new bytes");
    expect(calls.filter((call) => !call.startsWith("LocalFree"))).toEqual([
      "CreateFileW:C:\\:2000000",
      "NtCreateFile:.pending:2:file",
      "FlushFileBuffers:.pending",
      "SetSecurityInfo:8",
      "NtCreateFile:a.txt:1:file",
      "CloseHandle:a.txt",
      "rename:.pending->a.txt",
      "NtCreateFile:a.txt:1:file",
      "CloseHandle:a.txt",
      "CloseHandle:.pending",
    ]);
    expect(handles.size).toBe(1);

    const stale = directory.publishFileBytes(".pending2", "a.txt", Buffer.from("again"), snapshotOf(target, 999));
    expect(stale).toEqual({ status: "not_applied", error: "the publication target no longer matches its admitted snapshot" });
    expect(files.get("a.txt")?.content.toString()).toBe("new bytes");

    const created = directory.publishFileBytes(".pending3", "fresh.txt", Buffer.from("fresh"));
    expect(created).toEqual({ status: "published" });
    const collision = directory.publishFileBytes(".pending4", "fresh.txt", Buffer.from("fresh"));
    expect(collision).toEqual({ status: "not_applied", error: "the publication target no longer matches its admitted snapshot" });
  });

  it("publishes nonempty bytes without reading the write-only stage and verifies through a fresh read cursor", () => {
    const { api, ioCalls, files, handles } = fakeLibraries(new Map(), { maxTransferBytes: 3 });
    const directory = api.open("C:\\", [], false);
    expect(directory.publishFileBytes(".pending", "a.txt", Buffer.from("new bytes"))).toEqual({ status: "published" });
    expect(files.get("a.txt")?.content).toEqual(Buffer.from("new bytes"));
    const writes = ioCalls.filter((call) => call.operation === "write");
    const reads = ioCalls.filter((call) => call.operation === "read");
    expect(writes.map(({ name, access, cursor }) => ({ name, access, cursor }))).toEqual([
      { name: ".pending", access: 0x0017_0082, cursor: 0 },
      { name: ".pending", access: 0x0017_0082, cursor: 3 },
      { name: ".pending", access: 0x0017_0082, cursor: 6 },
    ]);
    expect(reads.map(({ name, access, cursor }) => ({ name, access, cursor }))).toEqual([
      { name: "a.txt", access: 0x0012_0081, cursor: 0 },
      { name: "a.txt", access: 0x0012_0081, cursor: 3 },
      { name: "a.txt", access: 0x0012_0081, cursor: 6 },
    ]);
    expect(new Set(writes.map(({ handle }) => handle)).size).toBe(1);
    expect(new Set(reads.map(({ handle }) => handle)).size).toBe(1);
    expect(reads[0]?.handle).not.toBe(writes[0]?.handle);
    directory.close();
    expect(handles.size).toBe(0);
  });

  it.each([
    ["content", { content: Buffer.from("new byteX") }],
    ["identity", { identity: 999 }],
    ["link count", { links: 2 }],
    ["DACL", { dacl: Buffer.from([2, 0, 8, 0, 0, 0, 0, 1]) }],
  ] satisfies [string, Partial<FakeFile>][])("reports changed installed %s as indeterminate", (_field, installedChange) => {
    const { api, ioCalls, handles } = fakeLibraries(new Map(), { maxTransferBytes: 3, installedChange });
    const directory = api.open("C:\\", [], false);
    expect(directory.publishFileBytes(".pending", "a.txt", Buffer.from("new bytes"), undefined, ACL)).toEqual({ status: "indeterminate", error: "published file verification failed" });
    expect(ioCalls.filter((call) => call.operation === "read").map(({ name, cursor }) => ({ name, cursor }))).toEqual([
      { name: "a.txt", cursor: 0 },
      { name: "a.txt", cursor: 3 },
      { name: "a.txt", cursor: 6 },
    ]);
    directory.close();
    expect(handles.size).toBe(0);
  });

  it("reports a failure before the rename as not applied and one after it as indeterminate", () => {
    const target: FakeFile = { content: Buffer.from("old"), identity: 5, links: 1, dacl: ACL };
    const flushFails = fakeLibraries(new Map([["a.txt", { ...target }]]), { failFlush: true });
    const flushDirectory = flushFails.api.open("C:\\", [], false);
    expect(flushDirectory.publishFileBytes(".pending", "a.txt", Buffer.from("new"), snapshotOf(target))).toEqual({ status: "not_applied", error: "FlushFileBuffers failed with Win32 error 1117" });

    const renameFails = fakeLibraries(new Map([["a.txt", { ...target }]]), { failRename: true });
    const renameDirectory = renameFails.api.open("C:\\", [], false);
    expect(renameDirectory.publishFileBytes(".pending", "a.txt", Buffer.from("new"), snapshotOf(target))).toEqual({ status: "not_applied", error: "NtSetInformationFile(rename) failed with NTSTATUS 0xc0000043" });

    const installFails = fakeLibraries(new Map([["installed-fails", { ...target }]]), { failInstalledOpen: true });
    const installDirectory = installFails.api.open("C:\\", [], false);
    const files = installFails.files;
    files.delete("installed-fails");
    const result = installDirectory.publishFileBytes(".pending", "installed-fails", Buffer.from("new"));
    expect(result).toEqual({ status: "indeterminate", error: "NtCreateFile failed with NTSTATUS 0xc0000022" });
  });

  it("deletes only a target that still matches its admitted snapshot", () => {
    const target: FakeFile = { content: Buffer.from("gone"), identity: 5, links: 1, dacl: ACL };
    const files = new Map<string, FakeFile>([["a.txt", target]]);
    const { api, calls } = fakeLibraries(files);
    const directory = api.open("C:\\", [], false);
    expect(directory.deleteFile("a.txt", snapshotOf(target, 999))).toEqual({ status: "not_applied", error: "the deletion target no longer matches its admitted snapshot" });
    expect(files.has("a.txt")).toBe(true);
    expect(directory.deleteFile("a.txt", snapshotOf(target))).toEqual({ status: "published" });
    expect(calls).toContain("delete:a.txt");
    expect(files.has("a.txt")).toBe(false);
    expect(directory.deleteFile("a.txt", snapshotOf(target))).toEqual({ status: "not_applied", error: "the deletion target is absent" });
  });

  it.skipIf(process.platform === "win32")("refuses to open the authority off Windows without binding any library", () => {
    expect(() => openNativeWindowsDirectory("C:\\", [])).toThrow("the retained Windows directory authority is available only on Windows");
  });
});
