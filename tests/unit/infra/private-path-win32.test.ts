import { describe, expect, spyOn, test } from "bun:test";
import * as ffi from "bun:ffi";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  createWindowsPrivateDirectoryAclAsyncPort,
  createWindowsPrivateDirectoryAclPort,
} from "../../../src/infra/windows-private-directory-acl.js";
import { ensurePrivateRootDirectory, ensurePrivateRootDirectoryAsync } from "../../../src/infra/private-path.js";
import { createWin32ContainedDirectoryBackend } from "../../../src/infra/descriptor-directory-win32.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

describe("Windows private directory ACLs", () => {
  test.each(["kernel", "open", "query", "user", "convert", "descriptor", "dacl", "read", "control", "apply", "success"] as const)(
    "owns native allocations and DLLs when %s completes initialization",
    (failure) => {
      const closed: string[] = [];
      const freed: number[] = [];
      const handles: number[] = [];
      const sid = Buffer.from("S-1-5-21-100-200-300-400\0", "utf16le");
      const descriptor = Buffer.alloc(8);
      const currentDescriptor = Buffer.alloc(8);
      const acl = Buffer.from([2, 0, 8, 0, 0, 0, 0, 0]);
      const foreignAcl = Buffer.from([2, 0, 8, 0, 1, 0, 0, 0]);
      const largerAcl = Buffer.from([2, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
      let currentAcl: Buffer | null = foreignAcl;
      let protectedDacl = true;
      let reads = 0;
      let controls = 0;
      let applications = 0;
      const writePointer = (address: ffi.Pointer, value: number) => {
        new BigUint64Array(ffi.toArrayBuffer(address, 0, 8))[0] = BigInt(value);
      };
      const loader = spyOn(ffi, "dlopen").mockImplementation((name) => {
        if (name === "kernel32.dll" && failure === "kernel") throw new Error("kernel unavailable");
        const symbols = name === "kernel32.dll" ? {
          GetCurrentProcess: () => 1,
          GetLastError: () => failure === "query" ? 87 : failure === "control" && controls > 0 ? 1338 : 122,
          CloseHandle: (handle: number) => { handles.push(handle); return 1; },
          LocalFree: (address: number) => { freed.push(address); return null; },
          lstrlenW: () => sid.length / 2 - 1,
        } : {
          OpenProcessToken: (_process: number, _access: number, output: ffi.Pointer) => {
            if (failure === "open") return 0;
            writePointer(output, 42);
            return 1;
          },
          GetTokenInformation: (_handle: number, _kind: number, user: ffi.Pointer | null, _size: number, length: ffi.Pointer) => {
            new Uint32Array(ffi.toArrayBuffer(length, 0, 4))[0] = 16;
            if (user === null || failure === "user") return 0;
            writePointer(user, ffi.ptr(sid));
            return 1;
          },
          ConvertSidToStringSidW: (_sid: ffi.Pointer, output: ffi.Pointer) => {
            if (failure === "convert") return 0;
            writePointer(output, ffi.ptr(sid));
            return 1;
          },
          ConvertStringSecurityDescriptorToSecurityDescriptorW: (_sddl: ffi.Pointer, _revision: number, output: ffi.Pointer) => {
            if (failure === "descriptor") return 0;
            writePointer(output, ffi.ptr(descriptor));
            return 1;
          },
          GetSecurityDescriptorDacl: (_descriptor: ffi.Pointer, _present: ffi.Pointer, output: ffi.Pointer) => {
            if (failure === "dacl") return 0;
            writePointer(output, ffi.ptr(acl));
            return 1;
          },
          GetNamedSecurityInfoW: (_name: ffi.Pointer, _kind: number, _information: number, _owner: null, _group: null, output: ffi.Pointer, _sacl: null, descriptorOutput: ffi.Pointer) => {
            reads++;
            if (failure === "read") return 5;
            writePointer(output, currentAcl === null ? 0 : ffi.ptr(currentAcl));
            writePointer(descriptorOutput, ffi.ptr(currentDescriptor));
            return 0;
          },
          GetSecurityDescriptorControl: (_descriptor: ffi.Pointer, control: ffi.Pointer) => {
            controls++;
            if (failure === "control") return 0;
            new Uint16Array(ffi.toArrayBuffer(control, 0, 2))[0] = protectedDacl ? 0x1000 : 0;
            return 1;
          },
          SetNamedSecurityInfoW: (_name: ffi.Pointer, _kind: number, _information: number, _owner: null, _group: null, dacl: ffi.Pointer) => {
            applications++;
            expect(Buffer.from(ffi.toArrayBuffer(dacl, 0, acl.length))).toEqual(acl);
            expect(freed.at(-1)).toBe(ffi.ptr(currentDescriptor));
            return failure === "apply" ? 5 : 0;
          },
        };
        // SAFETY: this double implements the consumed symbols; Bun's callable brand is private to its FFI loader.
        // dlopen is generic over the symbol map it is given, so the double's result stands in for every instance.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Bun's private callable brand cannot be constructed by this native-library test double
        return { symbols, close: () => { closed.push(String(name)); } } as never;
      });
      const launch = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("unexpected subprocess"); });
      try {
        const apply = createWindowsPrivateDirectoryAclPort({ platform: "win32" });
        if (failure === "success") {
          apply("/private");
          expect(applications).toBe(1);
          currentAcl = Buffer.from(acl);
          apply("/private");
          apply("/private");
          expect(applications).toBe(1);
          currentAcl = foreignAcl;
          apply("/private");
          expect(applications).toBe(2);
          currentAcl = largerAcl;
          apply("/private");
          expect(applications).toBe(3);
          currentAcl = Buffer.from(acl);
          protectedDacl = false;
          apply("/private");
          expect(applications).toBe(4);
          currentAcl = null;
          protectedDacl = true;
          apply("/private");
          expect(applications).toBe(5);
          expect(reads).toBe(7);
          expect(controls).toBe(7);
        } else {
          const message = failure === "read" ? "Cannot inspect private directory /private (Windows error 5)"
            : failure === "control" ? "Cannot inspect private directory control /private (Windows error 1338)"
              : failure === "apply" ? "Cannot protect private directory /private (Windows error 5)" : undefined;
          if (message) expect(() => apply("/private")).toThrow(message);
          else expect(() => apply("/private")).toThrow();
          expect(reads).toBe(["read", "control", "apply"].includes(failure) ? 1 : 0);
          expect(controls).toBe(["control", "apply"].includes(failure) ? 1 : 0);
          expect(applications).toBe(failure === "apply" ? 1 : 0);
        }
        expect(launch).not.toHaveBeenCalled();
        expect(handles).toEqual(["kernel", "open"].includes(failure) ? [] : [42]);
        expect(freed).toEqual(
          ["kernel", "open", "query", "user", "convert"].includes(failure) ? []
            : failure === "descriptor" ? [ffi.ptr(sid)]
              : [ffi.ptr(sid), ffi.ptr(descriptor), ...Array.from(
                { length: failure === "success" ? 7 : ["control", "apply"].includes(failure) ? 1 : 0 },
                () => ffi.ptr(currentDescriptor),
              )],
        );
        expect(closed).toEqual(failure === "kernel" ? ["advapi32.dll"]
          : ["read", "control", "apply", "success"].includes(failure) ? [] : ["kernel32.dll", "advapi32.dll"]);
      } finally {
        launch.mockRestore();
        loader.mockRestore();
      }
    },
  );

  test.each(["sync", "async"] as const)("refuses a linked %s root before applying its ACL", async (mode) => {
    const workspace = realpathSync(temporaryDirectory("private-path-win32-"));
    const outside = join(workspace, "outside");
    const root = join(workspace, "root");
    mkdirSync(outside);
    symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir");
    let calls = 0;
    const windowsAcl = () => { calls++; };
    if (mode === "sync") expect(() => ensurePrivateRootDirectory(root, { platform: "win32", windowsAcl })).toThrow();
    else await expect(ensurePrivateRootDirectoryAsync(root, { platform: "win32", windowsAcl: async () => windowsAcl() })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test.each(["sync", "async"] as const)("protects fresh and existing %s roots with one lazy native factory and an ACL per admission", async (mode) => {
    const workspace = realpathSync(temporaryDirectory("private-path-win32-"));
    try {
      const root = join(workspace, "root");
      const applications: string[] = [];
      let initializations = 0;
      const nativeAcl = () => {
        initializations++;
        return (directory: string) => { applications.push(directory); };
      };
      if (mode === "sync") {
        const acl = createWindowsPrivateDirectoryAclPort({ platform: "win32", nativeAcl });
        expect(initializations).toBe(0);
        ensurePrivateRootDirectory(root, { platform: "win32", windowsAcl: acl });
        ensurePrivateRootDirectory(root, { platform: "win32", windowsAcl: acl });
      } else {
        const acl = createWindowsPrivateDirectoryAclAsyncPort({ platform: "win32", nativeAcl });
        expect(initializations).toBe(0);
        await ensurePrivateRootDirectoryAsync(root, { platform: "win32", windowsAcl: acl });
        await ensurePrivateRootDirectoryAsync(root, { platform: "win32", windowsAcl: acl });
      }

      expect(initializations).toBe(1);
      expect(applications).toEqual([root, root]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("async root creation waits for its private ACL before returning the directory", async () => {
    const workspace = realpathSync(temporaryDirectory("private-path-win32-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      let ready = false;
      const creating = ensurePrivateRootDirectoryAsync(join(workspace, "root"), {
        platform: "win32",
        windowsAcl: async () => { entered.resolve(); await release.promise; },
      }).then(() => { ready = true; });
      await entered.promise;
      expect(ready).toBe(false);
      release.resolve();
      await creating;
      expect(ready).toBe(true);
    } finally {
      release.resolve();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("shares the lazy native ACL across concurrent async persistent spool admissions", async () => {
    let initializations = 0;
    const applications: string[] = [];
    const acl = createWindowsPrivateDirectoryAclAsyncPort({
      platform: "win32",
      nativeAcl: () => {
        initializations++;
        return (directory) => { applications.push(directory); };
      },
    });

    const first = acl("/spool/one");
    const second = acl("/spool/two");
    await Promise.all([first, second]);

    expect(initializations).toBe(1);
    expect(applications).toEqual(["/spool/one", "/spool/two"]);
  });

  test("applies no ACL launch to descendants that inherit from the contained root", () => {
    const workspace = realpathSync(temporaryDirectory("private-path-win32-"));
    const base = join(workspace, "base");
    mkdirSync(base);
    const aclCalls: string[] = [];
    const backend = createWin32ContainedDirectoryBackend({
      applyPrivateDirectoryAcl: (directory) => {
        aclCalls.push(directory);
      },
    });

    const root = backend.open(base, ["one", "two"], { privateDirectories: true });
    const descendant = root.openChild("three", { privateDirectories: true });
    descendant.close();
    root.close();

    expect(aclCalls).toEqual([join(base, "one")]);
    rmSync(workspace, { recursive: true, force: true });
  });

  test.each(["sync", "async"] as const)("refuses %s admission on identity or native ACL failure, including existing roots", async (mode) => {
    const workspace = realpathSync(temporaryDirectory("private-path-win32-"));
    try {
      const root = join(workspace, "root");
      for (const failure of ["identity", "native"] as const) {
        const nativeAcl = () => {
          if (failure === "identity") throw new Error("Cannot open current process token");
          return () => { throw new Error("ACL denied"); };
        };
        for (let admission = 0; admission < 2; admission++) {
          const message = failure === "identity" ? "current process token" : "ACL denied";
          if (mode === "sync") {
            const acl = createWindowsPrivateDirectoryAclPort({ platform: "win32", nativeAcl });
            expect(() => ensurePrivateRootDirectory(root, { platform: "win32", windowsAcl: acl })).toThrow(message);
          } else {
            const acl = createWindowsPrivateDirectoryAclAsyncPort({ platform: "win32", nativeAcl });
            await expect(ensurePrivateRootDirectoryAsync(root, { platform: "win32", windowsAcl: acl })).rejects.toThrow(message);
          }
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
