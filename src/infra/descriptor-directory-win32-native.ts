/** Retained Windows directory authority for byte-first file replacement.
 *
 *  A directory is held as one handle. Every child name is opened through
 *  `NtCreateFile` with that handle as `RootDirectory`, so no operation ever
 *  re-resolves a path: a directory moved, replaced, or linked away after
 *  admission cannot redirect a publication. A reparse point is never a
 *  contained entry. Publication stages the bytes under a pending name, compares
 *  the target against the admitted snapshot (identity, bytes, link count, and
 *  DACL), renames over it, and reads the installed file back; a failure after
 *  the rename is `indeterminate`, because the rename may have landed.
 *
 *  The kernel calls are bound through `bun:ffi` against `kernel32.dll`,
 *  `ntdll.dll`, and `advapi32.dll`, which every Windows process already runs
 *  on top of. Structures are laid out in buffers by hand: Windows x64 and arm64
 *  are both little-endian LLP64, so one layout serves both. The libraries open
 *  lazily and only on Windows. */

import { dlopen, FFIType, ptr, type Pointer, toArrayBuffer } from "bun:ffi";
import { ContainedFileTooLargeError, ContainedPathError } from "./descriptor-directory-contract.js";

export interface NativeWindowsFileSnapshot {
  readonly content: Buffer;
  readonly identity: string;
  readonly linkCount: number;
  readonly dacl: Buffer;
}

export type NativeWindowsMutationAttemptResult =
  | { readonly status: "published" }
  | { readonly status: "not_applied" | "indeterminate"; readonly error: string };

export interface NativeWindowsDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "reparse";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NativeWindowsDirectory {
  openChild(name: string, create: boolean): NativeWindowsDirectory | undefined;
  identity(): string;
  /** Enumerates the retained directory from the start, including reparse entries without following them. Throws on query failure or after close. */
  entries(): readonly NativeWindowsDirectoryEntry[];
  readFileSnapshot(name: string, maxBytes: number): NativeWindowsFileSnapshot | undefined;
  publishFileBytes(pending: string, name: string, content: Buffer, expected?: NativeWindowsFileSnapshot, dacl?: Buffer): NativeWindowsMutationAttemptResult;
  deleteFile(name: string, expected: NativeWindowsFileSnapshot): NativeWindowsMutationAttemptResult;
  /** Moves a file or directory between retained parents; refuses reparse points and throws ENOENT for an absent source. */
  renameInto(name: string, target: NativeWindowsDirectory, targetName: string): void;
  close(): void;
}

/** A `HANDLE`: pointer-sized, carried as a bigint so no value is ever rounded. */
type Handle = bigint;

/** The kernel32 entry points this module calls. Handles travel as `u64`, buffers as pointers. */
export interface Kernel32FileSymbols {
  CreateFileW(name: Pointer, access: number, share: number, security: null, creation: number, flags: number, template: bigint): bigint;
  CloseHandle(handle: bigint): number;
  GetLastError(): number;
  GetFileInformationByHandle(handle: bigint, information: Pointer): number;
  GetFileInformationByHandleEx(handle: bigint, informationClass: number, information: Pointer, length: number): number;
  ReadFile(handle: bigint, buffer: Pointer, bytes: number, read: Pointer, overlapped: null): number;
  WriteFile(handle: bigint, buffer: Pointer, bytes: number, written: Pointer, overlapped: null): number;
  FlushFileBuffers(handle: bigint): number;
  LocalFree(memory: bigint): bigint;
}

export interface NtdllFileSymbols {
  NtCreateFile(handle: Pointer, access: number, attributes: Pointer, status: Pointer, allocationSize: null, fileAttributes: number, share: number, disposition: number, options: number, eaBuffer: null, eaLength: number): number;
  NtQueryVolumeInformationFile(handle: bigint, status: Pointer, information: Pointer, length: number, informationClass: number): number;
  NtSetInformationFile(handle: bigint, status: Pointer, information: Pointer, length: number, informationClass: number): number;
}

export interface Advapi32FileSymbols {
  GetSecurityInfo(handle: bigint, objectType: number, information: number, owner: null, group: null, dacl: Pointer, sacl: null, descriptor: Pointer): number;
  SetSecurityInfo(handle: bigint, objectType: number, information: number, owner: null, group: null, dacl: Pointer, sacl: null): number;
}

export interface Win32FileLibraries {
  readonly kernel32: Kernel32FileSymbols;
  readonly ntdll: NtdllFileSymbols;
  readonly advapi32: Advapi32FileSymbols;
}

const DELETE = 0x0001_0000;
const SYNCHRONIZE = 0x0010_0000;
const FILE_TRAVERSE = 0x20;
const FILE_LIST_DIRECTORY = 0x01;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_READ_DATA = 0x01;
const FILE_WRITE_DATA = 0x02;
const READ_CONTROL = 0x0002_0000;
const WRITE_DAC = 0x0004_0000;
const FILE_SHARE_ALL = 0x07;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;
const FILE_DIRECTORY_FILE = 0x01;
const FILE_NON_DIRECTORY_FILE = 0x40;
const FILE_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
const OBJ_CASE_INSENSITIVE = 0x40;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_REMOTE_DEVICE = 0x10;
const DACL_SECURITY_INFORMATION = 0x04;
const SE_FILE_OBJECT = 1;
const FILE_RENAME_INFORMATION_CLASS = 10;
const FILE_DISPOSITION_INFORMATION_CLASS = 13;
const FILE_FS_DEVICE_INFORMATION_CLASS = 4;
const FILE_FS_ATTRIBUTE_INFORMATION_CLASS = 5;
const FILE_ID_BOTH_DIRECTORY_INFO_CLASS = 10;
const FILE_ID_BOTH_DIRECTORY_RESTART_INFO_CLASS = 11;
const ERROR_NO_MORE_FILES = 18;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
// NTSTATUS values arrive as signed 32-bit integers, so the error codes are their negative forms.
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034 - 0x1_0000_0000;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a - 0x1_0000_0000;
const STATUS_FILE_IS_A_DIRECTORY = 0xc00000ba - 0x1_0000_0000;
const STATUS_NOT_A_DIRECTORY = 0xc0000103 - 0x1_0000_0000;
const DIRECTORY_ACCESS = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY;
const READ_ACCESS = FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL;
/** `UNICODE_STRING.Length` is a byte count in a u16, so one component holds at most this many UTF-16 units. */
export const MAX_COMPONENT_UNITS = 32_767;

/** Byte offsets and sizes of the kernel structures, for Windows x64 and arm64 (both LLP64, little-endian). */
export const WIN32_LAYOUT = {
  unicodeString: { size: 16, length: 0, maximumLength: 2, buffer: 8 },
  objectAttributes: { size: 48, length: 0, rootDirectory: 8, objectName: 16, attributes: 24, securityDescriptor: 32, securityQualityOfService: 40 },
  ioStatusBlock: { size: 16, status: 0, information: 8 },
  byHandleFileInformation: { size: 52, attributes: 0, volumeSerial: 28, sizeHigh: 32, sizeLow: 36, links: 40, indexHigh: 44, indexLow: 48 },
  fileIdBothDirectoryInformation: { nextEntryOffset: 0, creationTime: 8, lastWriteTime: 24, attributes: 56, fileNameLength: 60, fileName: 104 },
  fileFsDeviceInformation: { size: 8, deviceType: 0, characteristics: 4 },
  fileFsAttributeInformation: { size: 76, attributes: 0, maximumComponentNameLength: 4, filesystemNameLength: 8, filesystemName: 12 },
  fileRenameInformation: { replaceIfExists: 0, rootDirectory: 8, fileNameLength: 16, fileName: 20 },
  fileDispositionInformation: { size: 1, deleteFile: 0 },
  aclHeader: { size: 8, revision: 0, aclSize: 2, aceCount: 4 },
} as const;

interface FileInformation {
  readonly attributes: number;
  readonly volumeSerial: number;
  readonly size: number;
  readonly links: number;
  readonly indexHigh: number;
  readonly indexLow: number;
}

function failure(message: string): Error {
  return new Error(message);
}

function reparsePointFailure(): ContainedPathError {
  return Object.assign(new ContainedPathError("a reparse point is not a contained entry; the contained entry is a symlink or junction"), { code: "ELOOP" });
}

function ntFailure(code: number, operation: string): Error {
  const unsigned = code < 0 ? code + 0x1_0000_0000 : code;
  const message = `${operation} failed with NTSTATUS 0x${unsigned.toString(16).padStart(8, "0")}`;
  if (code === STATUS_OBJECT_NAME_NOT_FOUND || code === STATUS_OBJECT_PATH_NOT_FOUND) return Object.assign(failure(message), { code: "ENOENT" });
  if (code === STATUS_FILE_IS_A_DIRECTORY) return Object.assign(new ContainedPathError(message), { code: "EISDIR" });
  if (code === STATUS_NOT_A_DIRECTORY) return Object.assign(new ContainedPathError(message), { code: "ENOTDIR" });
  return failure(message);
}

/** Encodes one validated Windows path component as UTF-16LE without a terminator, as `UNICODE_STRING` carries it. */
export function encodeComponentName(value: string): Uint8Array {
  if (value.length === 0 || value === "." || value === ".." || ["/", "\\", ":", "\0"].some((separator) => value.includes(separator))) throw failure("a child name must be one path component (one Windows path component)");
  if (value.length > MAX_COMPONENT_UNITS) throw failure(`a child name must be at most ${MAX_COMPONENT_UNITS} UTF-16 units`);
  return new Uint8Array(Buffer.from(value, "utf16le"));
}

/** Encodes a full path for `CreateFileW`: UTF-16LE with a NUL terminator. */
export function encodeWidePath(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(`${value}\0`, "utf16le"));
}

/** `OBJECT_ATTRIBUTES` naming one child of `root`, case-insensitively as Windows names are.
 *
 *  The structure, its `UNICODE_STRING`, and the encoded name share this one
 *  buffer, and the inner pointers address the buffer itself. The kernel follows
 *  those pointers, but the garbage collector does not: a name or string kept in
 *  a separate buffer is garbage once only its address is left, and a collection
 *  before the call can hand its memory to the next allocation, so the kernel
 *  reads another name (seen as STATUS_OBJECT_NAME_NOT_FOUND for a child that
 *  exists). One buffer is alive exactly as long as the argument that carries it. */
export function objectAttributesFor(root: bigint, name: Uint8Array): Uint8Array {
  const attributes = WIN32_LAYOUT.objectAttributes;
  const unicode = WIN32_LAYOUT.unicodeString;
  const unicodeOffset = attributes.size;
  const nameOffset = unicodeOffset + unicode.size;
  const buffer = new Uint8Array(nameOffset + name.byteLength);
  // `buffer.buffer` moves the bytes of a small typed array to their own
  // allocation, so it is read before `ptr` takes the address.
  const view = new DataView(buffer.buffer);
  const base = address(buffer);
  view.setUint32(attributes.length, attributes.size, true);
  view.setBigUint64(attributes.rootDirectory, root, true);
  view.setBigUint64(attributes.objectName, base + BigInt(unicodeOffset), true);
  view.setUint32(attributes.attributes, OBJ_CASE_INSENSITIVE, true);
  view.setUint16(unicodeOffset + unicode.length, name.byteLength, true);
  view.setUint16(unicodeOffset + unicode.maximumLength, name.byteLength, true);
  view.setBigUint64(unicodeOffset + unicode.buffer, base + BigInt(nameOffset), true);
  buffer.set(name, nameOffset);
  return buffer;
}

/** `FILE_RENAME_INFO` that replaces `target` under `root`; the name follows the header inline. */
export function renameInformationFor(root: bigint, target: Uint8Array): Uint8Array {
  const layout = WIN32_LAYOUT.fileRenameInformation;
  const buffer = new Uint8Array(Math.max(24, layout.fileName + target.byteLength));
  const view = new DataView(buffer.buffer);
  view.setUint8(layout.replaceIfExists, 1);
  view.setBigUint64(layout.rootDirectory, root, true);
  view.setUint32(layout.fileNameLength, target.byteLength, true);
  buffer.set(target, layout.fileName);
  return buffer;
}

export function fileInformationFrom(buffer: Uint8Array): FileInformation {
  const layout = WIN32_LAYOUT.byHandleFileInformation;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return {
    attributes: view.getUint32(layout.attributes, true),
    volumeSerial: view.getUint32(layout.volumeSerial, true),
    size: view.getUint32(layout.sizeHigh, true) * 0x1_0000_0000 + view.getUint32(layout.sizeLow, true),
    links: view.getUint32(layout.links, true),
    indexHigh: view.getUint32(layout.indexHigh, true),
    indexLow: view.getUint32(layout.indexLow, true),
  };
}

/**
 * Converts a FILETIME (100 ns intervals since 1601) to the Unix milliseconds that `fs.lstatSync` reports as
 * `birthtimeMs` and `mtimeMs`, bit for bit. Current tick counts exceed 2^53, so a direct `Number(ticks) / 10_000`
 * rounds the ticks before the division and can differ from `lstat` in the last bit. This splits whole seconds
 * from nanoseconds in exact integers and then uses the `sec * 1e3 + nsec / 1e6` arithmetic of the stat path. As
 * libuv does, a time before 1970 keeps its nanoseconds non-negative by borrowing one second.
 */
function unixMillisecondsOf(fileTime: bigint): number {
  const unixTicks = fileTime - 116444736000000000n;
  let seconds = unixTicks / 10_000_000n;
  let nanoseconds = (unixTicks % 10_000_000n) * 100n;
  if (nanoseconds < 0n) {
    seconds -= 1n;
    nanoseconds += 1_000_000_000n;
  }
  return Number(seconds) * 1_000 + Number(nanoseconds) / 1_000_000;
}

function identityOf(information: FileInformation): string {
  return `${information.volumeSerial}:${information.indexHigh.toString(16).padStart(8, "0")}${information.indexLow.toString(16).padStart(8, "0")}`;
}

function address(buffer: Uint8Array | BigUint64Array | Uint32Array): bigint {
  return BigInt(ptr(buffer));
}

function pointerOf(value: bigint): Pointer {
  // SAFETY: the kernel wrote this address into an out-parameter this module allocated; it is read once, bounded by the size the same structure declares, and freed by the same call.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Win32 API
  return Number(value) as Pointer;
}

function sameSnapshot(actual: NativeWindowsFileSnapshot | undefined, expected: NativeWindowsFileSnapshot | undefined): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return actual.identity === expected.identity && actual.content.equals(expected.content) && actual.linkCount === expected.linkCount && actual.dacl.equals(expected.dacl);
}

/** Builds the authority over already-opened libraries, so the call sequence can be proven with scripted libraries off Windows. */
export function createWin32NativeDirectoryApi(libraries: Win32FileLibraries) {
  const { kernel32, ntdll, advapi32 } = libraries;
  const lastError = kernel32.GetLastError;

  const win32Failure = (operation: string): Error => failure(`${operation} failed with Win32 error ${lastError()}`);

  const closeHandle = (handle: Handle): void => {
    kernel32.CloseHandle(handle);
  };

  const fileInformation = (handle: Handle): FileInformation => {
    const buffer = new Uint8Array(WIN32_LAYOUT.byHandleFileInformation.size);
    if (kernel32.GetFileInformationByHandle(handle, ptr(buffer)) === 0) throw win32Failure("GetFileInformationByHandle");
    return fileInformationFrom(buffer);
  };

  /** Opens `name` relative to `parent`; a status is returned to the caller so absence can be distinguished. */
  const ntCreateRelative = (parent: Handle, name: string, access: number, disposition: number, directory: boolean | undefined): { readonly handle: Handle } | { readonly status: number } => {
    const attributes = objectAttributesFor(parent, encodeComponentName(name));
    const io = new Uint8Array(WIN32_LAYOUT.ioStatusBlock.size);
    const out = new BigUint64Array([INVALID_HANDLE_VALUE]);
    const options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | (directory === undefined ? 0 : directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
    const status = ntdll.NtCreateFile(ptr(out), access | SYNCHRONIZE, ptr(attributes), ptr(io), null, 0, FILE_SHARE_ALL, disposition, options, null, 0);
    if (status < 0) return { status };
    const handle = out[0] ?? INVALID_HANDLE_VALUE;
    try {
      if ((fileInformation(handle).attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw reparsePointFailure();
    } catch (error) {
      closeHandle(handle);
      throw error;
    }
    return { handle };
  };

  const openRelative = (parent: Handle, name: string, access: number, disposition: number, directory: boolean | undefined): Handle => {
    const opened = ntCreateRelative(parent, name, access, disposition, directory);
    if ("status" in opened) throw ntFailure(opened.status, "NtCreateFile");
    return opened.handle;
  };

  const openRelativeOptional = (parent: Handle, name: string, access: number, directory: boolean): Handle | undefined => {
    const opened = ntCreateRelative(parent, name, access, FILE_OPEN, directory);
    if ("handle" in opened) return opened.handle;
    if (opened.status === STATUS_OBJECT_NAME_NOT_FOUND || opened.status === STATUS_OBJECT_PATH_NOT_FOUND) return undefined;
    throw ntFailure(opened.status, "NtCreateFile");
  };

  const withHandle = <T>(handle: Handle, use: (handle: Handle) => T): T => {
    try {
      return use(handle);
    } finally {
      closeHandle(handle);
    }
  };

  const requireLocalSupportedVolume = (handle: Handle): void => {
    const io = new Uint8Array(WIN32_LAYOUT.ioStatusBlock.size);
    const device = new Uint8Array(WIN32_LAYOUT.fileFsDeviceInformation.size);
    const deviceStatus = ntdll.NtQueryVolumeInformationFile(handle, ptr(io), ptr(device), device.byteLength, FILE_FS_DEVICE_INFORMATION_CLASS);
    if (deviceStatus < 0) throw ntFailure(deviceStatus, "NtQueryVolumeInformationFile(device)");
    if ((new DataView(device.buffer).getUint32(WIN32_LAYOUT.fileFsDeviceInformation.characteristics, true) & FILE_REMOTE_DEVICE) !== 0) throw failure("remote filesystems are not supported for retained publication");
    const layout = WIN32_LAYOUT.fileFsAttributeInformation;
    const attributes = new Uint8Array(layout.size);
    const attributesStatus = ntdll.NtQueryVolumeInformationFile(handle, ptr(io), ptr(attributes), attributes.byteLength, FILE_FS_ATTRIBUTE_INFORMATION_CLASS);
    if (attributesStatus < 0) throw ntFailure(attributesStatus, "NtQueryVolumeInformationFile(attributes)");
    const nameBytes = Math.min(new DataView(attributes.buffer).getUint32(layout.filesystemNameLength, true), layout.size - layout.filesystemName);
    const name = Buffer.from(attributes.subarray(layout.filesystemName, layout.filesystemName + nameBytes)).toString("utf16le");
    if (name !== "NTFS" && name !== "ReFS") throw failure(`filesystem ${name} is not supported for retained publication`);
  };

  /** The file's DACL bytes. A null DACL grants everyone everything and is never admissible evidence. */
  const readDacl = (handle: Handle): Buffer => {
    const aclOut = new BigUint64Array(1);
    const descriptorOut = new BigUint64Array(1);
    const code = advapi32.GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, ptr(aclOut), null, ptr(descriptorOut));
    if (code !== 0) throw failure(`GetSecurityInfo failed with Win32 error ${code}`);
    const descriptor = descriptorOut[0] ?? 0n;
    try {
      const acl = aclOut[0] ?? 0n;
      if (acl === 0n) throw failure("a null DACL is not admissible");
      const header = new DataView(toArrayBuffer(pointerOf(acl), 0, WIN32_LAYOUT.aclHeader.size));
      const size = header.getUint16(WIN32_LAYOUT.aclHeader.aclSize, true);
      if (size < WIN32_LAYOUT.aclHeader.size) throw failure("the file's DACL is malformed");
      return Buffer.from(new Uint8Array(toArrayBuffer(pointerOf(acl), 0, size)));
    } finally {
      if (descriptor !== 0n) kernel32.LocalFree(descriptor);
    }
  };

  const applyDacl = (handle: Handle, bytes: Buffer): void => {
    if (bytes.byteLength < WIN32_LAYOUT.aclHeader.size) throw failure("DACL evidence is missing or malformed");
    if (bytes.readUInt16LE(WIN32_LAYOUT.aclHeader.aclSize) !== bytes.byteLength) throw failure("DACL evidence has an invalid length");
    const acl = new Uint8Array(bytes);
    const code = advapi32.SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, ptr(acl), null);
    if (code !== 0) throw failure(`SetSecurityInfo failed with Win32 error ${code}`);
  };

  /** Whether the file behind `handle` still is `expected`, with one byte of mismatch evidence beyond the admitted size. */
  const stillMatches = (handle: Handle, expected: NativeWindowsFileSnapshot): boolean => {
    const information = fileInformation(handle);
    if (identityOf(information) !== expected.identity || information.links !== expected.linkCount) return false;
    return sameSnapshot(readSnapshot(handle, expected.content.byteLength + 1), expected);
  };

  const readSnapshot = (handle: Handle, maxBytes: number): NativeWindowsFileSnapshot => {
    const information = fileInformation(handle);
    // The size limit is a contract condition, not a Windows condition: a reader
    // that treats an oversized file as absent evidence tests the contract error,
    // and the POSIX backend and this backend's own non-native path both raise it.
    if (information.size > maxBytes) throw new ContainedFileTooLargeError(maxBytes);
    const content = new Uint8Array(information.size);
    const transferred = new Uint32Array(1);
    let offset = 0;
    while (offset < content.byteLength) {
      if (kernel32.ReadFile(handle, ptr(content, offset), content.byteLength - offset, ptr(transferred), null) === 0) throw win32Failure("ReadFile");
      const read = transferred[0] ?? 0;
      if (read === 0) break;
      offset += read;
    }
    return { content: Buffer.from(content.subarray(0, offset)), identity: identityOf(information), linkCount: information.links, dacl: readDacl(handle) };
  };

  const writeAll = (handle: Handle, content: Uint8Array): void => {
    const transferred = new Uint32Array(1);
    let offset = 0;
    while (offset < content.byteLength) {
      if (kernel32.WriteFile(handle, ptr(content, offset), content.byteLength - offset, ptr(transferred), null) === 0) throw win32Failure("WriteFile");
      const written = transferred[0] ?? 0;
      if (written === 0) throw failure("WriteFile made no progress");
      offset += written;
    }
  };

  const markForDeletion = (handle: Handle): void => {
    const disposition = new Uint8Array([1]);
    const io = new Uint8Array(WIN32_LAYOUT.ioStatusBlock.size);
    const status = ntdll.NtSetInformationFile(handle, ptr(io), ptr(disposition), disposition.byteLength, FILE_DISPOSITION_INFORMATION_CLASS);
    if (status < 0) throw ntFailure(status, "NtSetInformationFile(delete)");
  };

  class WindowsDirectory implements NativeWindowsDirectory {
    #handle: Handle | undefined;

    constructor(handle: Handle) {
      this.#handle = handle;
    }

    #held(): Handle {
      if (this.#handle === undefined) throw failure("directory is closed");
      return this.#handle;
    }

    identity(): string {
      return identityOf(fileInformation(this.#held()));
    }

    entries(): readonly NativeWindowsDirectoryEntry[] {
      const handle = this.#held();
      const buffer = Buffer.alloc(64 * 1024);
      const layout = WIN32_LAYOUT.fileIdBothDirectoryInformation;
      const entries: NativeWindowsDirectoryEntry[] = [];
      let informationClass = FILE_ID_BOTH_DIRECTORY_RESTART_INFO_CLASS;
      for (;;) {
        if (kernel32.GetFileInformationByHandleEx(handle, informationClass, ptr(buffer), buffer.byteLength) === 0) {
          const code = lastError();
          if (code === ERROR_NO_MORE_FILES) return entries;
          throw failure(`GetFileInformationByHandleEx(directory) failed with Win32 error ${code}`);
        }
        informationClass = FILE_ID_BOTH_DIRECTORY_INFO_CLASS;
        let offset = 0;
        for (;;) {
          const nameBytes = buffer.readUInt32LE(offset + layout.fileNameLength);
          const name = buffer.toString("utf16le", offset + layout.fileName, offset + layout.fileName + nameBytes);
          if (name !== "." && name !== "..") {
            const attributes = buffer.readUInt32LE(offset + layout.attributes);
            entries.push({
              name,
              kind: (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 ? "reparse" : (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 ? "directory" : "file",
              createdAt: unixMillisecondsOf(buffer.readBigInt64LE(offset + layout.creationTime)),
              updatedAt: unixMillisecondsOf(buffer.readBigInt64LE(offset + layout.lastWriteTime)),
            });
          }
          const next = buffer.readUInt32LE(offset + layout.nextEntryOffset);
          if (next === 0) break;
          offset += next;
        }
      }
    }

    openChild(name: string, create: boolean): NativeWindowsDirectory | undefined {
      const parent = this.#held();
      const child = create ? openRelative(parent, name, DIRECTORY_ACCESS, FILE_OPEN_IF, true) : openRelativeOptional(parent, name, DIRECTORY_ACCESS, true);
      return child === undefined ? undefined : new WindowsDirectory(child);
    }

    readFileSnapshot(name: string, maxBytes: number): NativeWindowsFileSnapshot | undefined {
      const file = openRelativeOptional(this.#held(), name, READ_ACCESS, false);
      return file === undefined ? undefined : withHandle(file, (handle) => readSnapshot(handle, maxBytes));
    }

    publishFileBytes(pending: string, name: string, content: Buffer, expected?: NativeWindowsFileSnapshot, dacl?: Buffer): NativeWindowsMutationAttemptResult {
      let published = false;
      try {
        const parent = this.#held();
        const bytes = new Uint8Array(content);
        withHandle(openRelative(parent, pending, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | DELETE, FILE_CREATE, false), (staged) => {
          try {
            writeAll(staged, bytes);
            if (kernel32.FlushFileBuffers(staged) === 0) throw win32Failure("FlushFileBuffers");
            if (dacl !== undefined) applyDacl(staged, dacl);
            const stagedIdentity = identityOf(fileInformation(staged));
            const stagedDacl = readDacl(staged);
            const currentHandle = openRelativeOptional(parent, name, READ_ACCESS, false);
            // An absent target matches only an absent admission; a present one must still be the admitted file.
            const matches = currentHandle === undefined ? expected === undefined : withHandle(currentHandle, (handle) => expected !== undefined && stillMatches(handle, expected));
            if (!matches) throw failure("the publication target no longer matches its admitted snapshot");
            const rename = renameInformationFor(0n, encodeComponentName(name));
            const renameIo = new Uint8Array(WIN32_LAYOUT.ioStatusBlock.size);
            const renameStatus = ntdll.NtSetInformationFile(staged, ptr(renameIo), ptr(rename), rename.byteLength, FILE_RENAME_INFORMATION_CLASS);
            if (renameStatus < 0) throw ntFailure(renameStatus, "NtSetInformationFile(rename)");
            published = true;
            const installed = withHandle(openRelative(parent, name, READ_ACCESS, FILE_OPEN, false), (handle) => readSnapshot(handle, bytes.byteLength));
            if (installed.identity !== stagedIdentity || !installed.content.equals(content) || installed.linkCount !== 1 || !installed.dacl.equals(stagedDacl)) {
              throw failure("published file verification failed");
            }
          } finally {
            if (!published) markForDeletion(staged);
          }
        });
        return { status: "published" };
      } catch (error) {
        return { status: published ? "indeterminate" : "not_applied", error: error instanceof Error ? error.message : String(error) };
      }
    }

    deleteFile(name: string, expected: NativeWindowsFileSnapshot): NativeWindowsMutationAttemptResult {
      try {
        const file = openRelativeOptional(this.#held(), name, DELETE | READ_ACCESS, false);
        if (file === undefined) throw failure("the deletion target is absent");
        withHandle(file, (handle) => {
          if (!stillMatches(handle, expected)) throw failure("the deletion target no longer matches its admitted snapshot");
          markForDeletion(handle);
        });
        return { status: "published" };
      } catch (error) {
        return { status: "not_applied", error: error instanceof Error ? error.message : String(error) };
      }
    }

    renameInto(name: string, target: NativeWindowsDirectory, targetName: string): void {
      if (!(target instanceof WindowsDirectory)) throw failure("contained directories must use the same native backend");
      const parent = this.#held();
      const rename = renameInformationFor(target.#held(), encodeComponentName(targetName));
      withHandle(openRelative(parent, name, DELETE | FILE_READ_ATTRIBUTES, FILE_OPEN, undefined), (handle) => {
        const io = new Uint8Array(WIN32_LAYOUT.ioStatusBlock.size);
        const status = ntdll.NtSetInformationFile(handle, ptr(io), ptr(rename), rename.byteLength, FILE_RENAME_INFORMATION_CLASS);
        if (status < 0) throw ntFailure(status, "NtSetInformationFile(rename)");
      });
    }

    close(): void {
      if (this.#handle === undefined) return;
      const handle = this.#handle;
      this.#handle = undefined;
      closeHandle(handle);
    }
  }

  return {
    /** Opens `baseDir` by path once, then every component of `dirs` relative to the previous handle. */
    open(baseDir: string, dirs: readonly string[], noFollowBase: boolean): NativeWindowsDirectory {
      const path = encodeWidePath(baseDir);
      const flags = FILE_FLAG_BACKUP_SEMANTICS | (noFollowBase ? FILE_FLAG_OPEN_REPARSE_POINT : 0);
      const base = kernel32.CreateFileW(ptr(path), DIRECTORY_ACCESS, FILE_SHARE_ALL, null, OPEN_EXISTING, flags, 0n);
      if (base === INVALID_HANDLE_VALUE) throw win32Failure("CreateFileW(base)");
      let current = base;
      try {
        requireLocalSupportedVolume(current);
        if (noFollowBase && (fileInformation(current).attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw failure("the base is a reparse point");
        for (const component of dirs) {
          const next = openRelative(current, component, DIRECTORY_ACCESS, FILE_OPEN, true);
          closeHandle(current);
          current = next;
        }
      } catch (error) {
        closeHandle(current);
        throw error;
      }
      return new WindowsDirectory(current);
    },
  };
}

type Win32NativeDirectoryApi = ReturnType<typeof createWin32NativeDirectoryApi>;

function openWin32FileLibraries(): Win32FileLibraries {
  const kernel32 = dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    GetFileInformationByHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    GetFileInformationByHandleEx: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    FlushFileBuffers: { args: [FFIType.u64], returns: FFIType.i32 },
    LocalFree: { args: [FFIType.u64], returns: FFIType.u64 },
  }).symbols;
  const ntdll = dlopen("ntdll.dll", {
    NtCreateFile: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    NtQueryVolumeInformationFile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    NtSetInformationFile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  }).symbols;
  const advapi32 = dlopen("advapi32.dll", {
    GetSecurityInfo: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    SetSecurityInfo: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  }).symbols;
  return { kernel32, ntdll, advapi32 };
}

let api: Win32NativeDirectoryApi | undefined;
let loadFailure: Error | undefined;

/** Opens the Windows-only retained directory authority. The libraries bind on first use and stay bound. */
export function openNativeWindowsDirectory(baseDir: string, dirs: readonly string[], noFollowBase = false): NativeWindowsDirectory {
  if (process.platform !== "win32") throw new Error("the retained Windows directory authority is available only on Windows");
  if (loadFailure) throw new Error(loadFailure.message, { cause: loadFailure });
  if (api === undefined) {
    try {
      api = createWin32NativeDirectoryApi(openWin32FileLibraries());
    } catch (error) {
      const failed = new Error(`the Windows file authority could not bind its system libraries: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      loadFailure = failed;
      throw failed;
    }
  }
  return api.open(baseDir, dirs, noFollowBase);
}
