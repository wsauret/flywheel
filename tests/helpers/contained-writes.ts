/** Fakes at the contained-directory boundary: a record of the stream writes
 *  it makes, so a test can ask what reached the disk, including writes that
 *  failed, and an unlink that the platform refuses. */

import { setContainedDirectoryBackendForTests, type ContainedDirectoryContract, type ContainedDirectoryOptions } from "../../src/infra/descriptor-directory.js";
import { posixContainedDirectoryBackend } from "../../src/infra/descriptor-directory-posix.js";

/** Every contained directory opened from now on, and every child it opens,
 *  is the real POSIX one with the members `override` returns. Own properties
 *  shadow the backend's methods on the same object, so its private state and
 *  its same-backend checks still hold. */
function overrideContainedDirectories(override: (contract: ContainedDirectoryContract) => Partial<ContainedDirectoryContract>): void {
  const wrap = (contract: ContainedDirectoryContract): ContainedDirectoryContract => {
    const openChild = contract.openChild.bind(contract);
    return Object.assign(contract, override(contract), {
      openChild: (name: string, options?: ContainedDirectoryOptions) => wrap(openChild(name, options)),
    });
  };
  setContainedDirectoryBackendForTests({
    open: (baseDir, dirs, options) => wrap(posixContainedDirectoryBackend.open(baseDir, dirs, options)),
    openExisting: (baseDir, dirs, options) => {
      const opened = posixContainedDirectoryBackend.openExisting(baseDir, dirs, options);
      return opened === undefined ? undefined : wrap(opened);
    },
  });
}

/** Every stream write a contained directory makes from now on, by entry
 *  name and the bytes its source delivered, whether or not the write
 *  completed. */
export function recordContainedWrites(): { readonly name: string; bytes: number }[] {
  const writes: { readonly name: string; bytes: number }[] = [];
  /** @yields {Uint8Array} each chunk of `source`, counted on its way through. */
  async function* counted(entry: { readonly name: string; bytes: number }, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncIterable<Uint8Array> {
    for await (const chunk of source) {
      entry.bytes += chunk.byteLength;
      yield chunk;
    }
  }
  overrideContainedDirectories((contract) => {
    const write = contract.writeStreamExclusive.bind(contract);
    return {
      writeStreamExclusive: (name, source, options) => {
        const entry = { name, bytes: 0 };
        writes.push(entry);
        return write(name, counted(entry, source), options);
      },
    };
  });
  return writes;
}

/** From now on, unlinking an entry called `name` throws `message`, as
 *  Windows does while a scanner holds the file. */
export function failContainedFileRemoval(name: string, message: string): void {
  overrideContainedDirectories((contract) => {
    const removeFile = contract.removeFile.bind(contract);
    return {
      removeFile: (entry) => {
        if (entry === name) throw new Error(message);
        removeFile(entry);
      },
    };
  });
}
