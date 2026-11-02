import { afterAll, beforeAll } from "bun:test";
import { setContainedDirectoryBackendForTests } from "../../src/infra/descriptor-directory.js";
import { createWin32ContainedDirectoryBackend, type Win32ContainedDirectoryOperations } from "../../src/infra/descriptor-directory-win32.js";

/** Run the calling file or `describe` block on the path-held Windows
 *  contained-directory backend, which works on every host, so Windows
 *  primitives such as the `current` pointer file are what the code under
 *  test meets. `operations` reads the overrides at each open, so a case can
 *  stand in for a Windows refusal. Call it once at the top level of the file
 *  or block, because it registers hooks in that scope. */
export function useWin32ContainedDirectories(operations: () => Partial<Win32ContainedDirectoryOperations> = () => ({})): void {
  beforeAll(() => {
    setContainedDirectoryBackendForTests({
      open: (baseDir, dirs, options) => createWin32ContainedDirectoryBackend({ retainedAuthority: false, ...operations() }).open(baseDir, dirs, options),
      openExisting: (baseDir, dirs, options) => createWin32ContainedDirectoryBackend({ retainedAuthority: false, ...operations() }).openExisting(baseDir, dirs, options),
    });
  });
  afterAll(() => { setContainedDirectoryBackendForTests(undefined); });
}
