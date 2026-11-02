import { describe, expect, spyOn, test } from "bun:test";
import { POSIX_FAILURE_STAGING } from "../../../helpers/posix-failure-staging.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { AuthProfileRetirementsError } from "../../../../src/infra/auth/auth-profile-retirements.js";
import { ContainedDirectory, ContainedPathError } from "../../../../src/infra/descriptor-directory.js";
import { authDir } from "../../../../src/infra/paths.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { HOLDS_DIRECTORY_VALUES } from "../../../helpers/held-directory-values.js";

const LEGACY_FILES = ["auth.json"] as const;
const RETIRED_FILES = ["openai-models.json", "copilot-models.json"] as const;
const temporaryDirectory = temporaryDirectories();
describe("AuthProfileStore", () => {
  test.each([
    "{broken",
    '{"version":2,"successors":{}}',
    '{"version":1,"successors":{"a":"b","b":"c"}}',
    '{"version":1,"successors":{"a":"a"}}',
    '{"version":1,"successors":{},"extra":true}',
  ])("preserves unreadable retirement bytes and refuses an empty-ledger fallback: %s", async (bytes) => {
    const root = temporaryDirectory("auth-profile-ledger-invalid-");
    const store = new AuthProfileStore(root);
    (await store.create("work")).close();
    const file = join(root, "auth", ".profile-retirements.json");
    writeFileSync(file, bytes);
    expect(() => store.inspect()).toThrow(AuthProfileRetirementsError);
    await expect(store.create("other")).rejects.toThrow(AuthProfileRetirementsError);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(existsSync(authDir(root, "work"))).toBe(true);
  });

  test("commits one-hop retirements before removal and hides physical leftovers", async () => {
    const root = temporaryDirectory("auth-profile-ledger-");
    const store = new AuthProfileStore(root);
    expect(store.inspect().retirements).toEqual({});
    for (const id of ["a", "b", "c"]) (await store.create(id)).close();
    await store.withOperation((operation) => {
      operation.retire("a", "b");
      expect(existsSync(authDir(root, "a"))).toBe(true);
      expect(operation.open("a")).toBeUndefined();
      operation.retire("b", "c");
    });
    expect(store.inspect()).toMatchObject({ profiles: [{ id: "c" }], retirements: { a: "c", b: "c" } });
    await expect(store.create("a")).rejects.toThrow("retired");
    await store.delete("a");
    await store.delete("a");
    expect(existsSync(authDir(root, "c"))).toBe(true);
  });
  test("creates stable profile ids with display metadata and reads legacy profiles lazily", async () => {
    const root = temporaryDirectory("auth-profile-store-");
    const store = new AuthProfileStore(root);

    const profile = await store.create("work", "Work Account");
    profile.writeFile("openai.json", "secret");
    profile.close();
    mkdirSync(authDir(root, "legacy"), { recursive: true });
    mkdirSync(authDir(root, "default"), { recursive: true });
    writeFileSync(join(authDir(root, "legacy"), "profile.json"), JSON.stringify({ displayName: "bad\nname" }));

    expect(await store.list()).toEqual([
      { id: "default", displayName: "Default" },
      { id: "legacy", displayName: "legacy" },
      { id: "work", displayName: "Work Account" },
    ]);
    expect(JSON.parse(readFileSync(join(authDir(root, "work"), "profile.json"), "utf8"))).toEqual({ displayName: "Work Account" });
    expect(readFileSync(join(authDir(root, "work"), "openai.json"), "utf8")).toBe("secret");
  });

  test("ignores non-directory entries beside auth profiles", async () => {
    const root = temporaryDirectory("auth-profile-store-entries-");
    const store = new AuthProfileStore(root);
    (await store.create("work", "Work Account")).close();
    writeFileSync(join(root, "auth", "profiles", ".DS_Store"), "finder metadata");

    expect(await store.list()).toEqual([{ id: "work", displayName: "Work Account" }]);
  });

  test("renames only the display name through an atomic descriptor-backed write", async () => {
    const root = temporaryDirectory("auth-profile-store-rename-");
    const store = new AuthProfileStore(root);
    const access = await store.create("work", "Work");
    access.close();

    await store.rename("work", "Personal Work");

    expect(await store.list()).toEqual([{ id: "work", displayName: "Personal Work" }]);
    expect(existsSync(authDir(root, "work"))).toBe(true);
    expect(readdirSync(authDir(root, "work")).sort()).toEqual(["profile.json"]);
  });

  test("deletes the complete profile tree and rejects missing profiles", async () => {
    const root = temporaryDirectory("auth-profile-store-delete-");
    const store = new AuthProfileStore(root);
    const access = await store.create("work", "Work");
    access.writeFile("credentials.json", "secret");
    access.close();
    mkdirSync(join(authDir(root, "work"), "nested"));
    writeFileSync(join(authDir(root, "work"), "nested", "cache.json"), "cache");

    await store.delete("work");

    expect(existsSync(authDir(root, "work"))).toBe(false);
    await expect(store.delete("work")).rejects.toThrow("auth profile does not exist: work");
  });

  test("holds the profile writer lock across pre-remove settlement and removal", async () => {
    const root = temporaryDirectory("auth-profile-store-pre-remove-");
    const store = new AuthProfileStore(root);
    (await store.create("work", "Work")).close();
    let releaseSettlement: (() => void) | undefined;
    const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    let entered = false;
    const deletion = store.delete("work", async () => {
      entered = true;
      expect(existsSync(authDir(root, "work"))).toBe(true);
      await settlement;
      return () => {};
    });
    await Bun.sleep(5);
    expect(entered).toBe(true);
    expect(existsSync(authDir(root, "work"))).toBe(true);
    releaseSettlement?.();
    await deletion;
    expect(existsSync(authDir(root, "work"))).toBe(false);
  });

  test("waits for a profile writer before deleting its tree", async () => {
    const root = temporaryDirectory("auth-profile-store-delete-lock-");
    const store = new AuthProfileStore(root);
    const access = await store.create("work", "Work");
    let releaseWriter: (() => void) | undefined;
    const writerReleased = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let writerReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { writerReady = resolve; });
    const writer = access.withLock(async () => {
      writerReady?.();
      await writerReleased;
    });
    await ready;
    let deleted = false;
    const deletion = store.delete("work").then(() => { deleted = true; });
    await Bun.sleep(5);
    expect(deleted).toBe(false);

    releaseWriter?.();
    await writer;
    await deletion;
    access.close();
    expect(existsSync(authDir(root, "work"))).toBe(false);
  });

  test.skipIf(!POSIX_FAILURE_STAGING)("profile metadata writes surface post-commit directory sync failures", async () => {
    const fs = await import("node:fs");
    const root = temporaryDirectory("auth-profile-durability-");
    const store = new AuthProfileStore(root);
    (await store.create("work", "Work")).close();
    const metadataPath = join(authDir(root, "work"), "profile.json");
    const originalFsync = fs.fsyncSync;
    let failed = false;
    const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const committed = existsSync(metadataPath) && JSON.parse(readFileSync(metadataPath, "utf8")).displayName === "Committed Name";
      if (!failed && committed && fs.fstatSync(fd).isDirectory()) {
        failed = true;
        throw new Error("profile directory sync boom");
      }
      return originalFsync(fd);
    });
    try {
      await expect(store.rename("work", "Committed Name")).rejects.toThrow("profile directory sync boom");
    } finally {
      sync.mockRestore();
    }
    expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toEqual({ displayName: "Committed Name" });
  });

  test("moves legacy auth into default and retires unattributed model catalogs", async () => {
    const root = temporaryDirectory("auth-profile-store-");
    const auth = join(root, "auth");
    mkdirSync(auth, { recursive: true });
    writeFileSync(join(auth, "auth.json"), Buffer.from([0, 0, 255]));
    for (const name of RETIRED_FILES) writeFileSync(join(auth, name), "retired");
    writeFileSync(join(auth, "mcp-credentials.json"), "mcp");

    const profile = await new AuthProfileStore(root).open("default");
    expect(profile).toBeDefined();
    profile?.close();
    expect(readFileSync(join(auth, "profiles", "default", "auth.json"))).toEqual(Buffer.from([0, 0, 255]));
    expect(existsSync(join(auth, "auth.json"))).toBe(false);
    for (const name of RETIRED_FILES) {
      expect(existsSync(join(auth, name))).toBe(false);
      expect(existsSync(join(auth, "profiles", "default", name))).toBe(false);
    }
    expect(readFileSync(join(auth, "mcp-credentials.json"), "utf8")).toBe("mcp");
    expect(existsSync(join(auth, ".profile-operation.json"))).toBe(false);
  });

  test("rolls auth migration forward and retires model catalogs after interruption", async () => {
    for (const failAt of LEGACY_FILES.flatMap((file) => [`before:${file}`, `after:${file}`] as const)) {
      const root = temporaryDirectory("auth-profile-store-");
      const auth = join(root, "auth");
      mkdirSync(auth, { recursive: true });
      writeFileSync(join(auth, "auth.json"), Buffer.from([0, 0, 255]));
      for (const name of RETIRED_FILES) writeFileSync(join(auth, name), "retired");
      let failed = false;
      const interrupted = new AuthProfileStore(root, {
        migrationFault: (stage) => {
          if (!failed && stage === failAt) {
            failed = true;
            throw new Error(`injected ${stage}`);
          }
        },
      });

      await expect(interrupted.open("default")).rejects.toThrow(`injected ${failAt}`);
      const recovered = await new AuthProfileStore(root).open("default");
      recovered?.close();
      expect(readFileSync(join(auth, "profiles", "default", "auth.json"))).toEqual(Buffer.from([0, 0, 255]));
      expect(existsSync(join(auth, "auth.json"))).toBe(false);
      for (const name of RETIRED_FILES) {
        expect(existsSync(join(auth, name))).toBe(false);
        expect(existsSync(join(auth, "profiles", "default", name))).toBe(false);
      }
      expect(existsSync(join(auth, ".profile-operation.json"))).toBe(false);
    }
  });

  test("refuses an unrecognized legacy and profile conflict", async () => {
    const root = temporaryDirectory("auth-profile-store-");
    const auth = join(root, "auth");
    mkdirSync(join(auth, "profiles", "default"), { recursive: true });
    writeFileSync(join(auth, "auth.json"), "source");
    writeFileSync(join(auth, "profiles", "default", "auth.json"), "destination");

    await expect(new AuthProfileStore(root).open("default")).rejects.toThrow("unrecognized legacy profile migration conflict");
    expect(readFileSync(join(auth, "auth.json"), "utf8")).toBe("source");
    expect(readFileSync(join(auth, "profiles", "default", "auth.json"), "utf8")).toBe("destination");
  });

  test("recognized recovery removes a duplicate source only when its bytes equal the destination", async () => {
    for (const [source, destination, succeeds] of [["same", "same", true], ["source", "destination", false]] as const) {
      const root = temporaryDirectory("auth-profile-store-");
      const auth = join(root, "auth");
      mkdirSync(join(auth, "profiles", "default"), { recursive: true });
      writeFileSync(join(auth, "auth.json"), source);
      writeFileSync(join(auth, "profiles", "default", "auth.json"), destination);
      writeFileSync(join(auth, ".profile-operation.json"), JSON.stringify({
        kind: "legacy-profile-migration",
        operationId: "legacy-to-default-v1",
        from: "account-root",
        to: "default",
      }));

      const access = new AuthProfileStore(root).open("default");
      if (succeeds) {
        (await access)?.close();
        expect(existsSync(join(auth, "auth.json"))).toBe(false);
      } else {
        await expect(access).rejects.toThrow("legacy profile migration conflict");
        expect(readFileSync(join(auth, "auth.json"), "utf8")).toBe(source);
      }
      expect(readFileSync(join(auth, "profiles", "default", "auth.json"), "utf8")).toBe(destination);
    }
  });

  test("watches catalog metadata but ignores internal profile-lock notifications", async () => {
    const fs = await import("node:fs");
    const root = temporaryDirectory("auth-profile-catalog-watcher-");
    const store = new AuthProfileStore(root);
    (await store.create("work", "Work")).close();
    const controlled = fs.watch(root, () => {});
    let notify: unknown;
    const watching = spyOn(fs, "watch").mockImplementation((...args: unknown[]) => {
      notify = args.at(-1);
      return controlled;
    });
    let changes = 0;
    const watcher = store.watchCatalog(() => { changes += 1; }, (error) => { throw error; });
    try {
      if (typeof notify !== "function") throw new Error("catalog watcher did not register its callback");
      for (const filename of [
        "profiles/profile-locks",
        "profiles\\profile-locks",
        "profiles/profile-locks/.profile.work.lock",
      ]) notify("change", filename);
      expect(changes).toBe(0);
      for (const filename of ["profiles", "profiles/work", "profiles/work/profile.json", ".profile-retirements.json"]) {
        notify("rename", filename);
      }
      expect(changes).toBe(4);
    } finally {
      watcher.dispose();
      watching.mockRestore();
    }
  });

  test("a confirmed catalog watch holds the inspection until a catalog entry changes", async () => {
    const fs = await import("node:fs");
    const root = temporaryDirectory("auth-profile-catalog-held-");
    const store = new AuthProfileStore(root);
    (await store.create("work", "Work")).close();
    const controlled = fs.watch(root, () => {});
    let notify: (event: string, filename: string) => void = () => { throw new Error("catalog watcher did not register its callback"); };
    const watching = spyOn(fs, "watch").mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") notify = (event, filename) => { callback(event, filename); };
      return controlled;
    });
    const watcher = store.watchCatalog(() => {}, (error) => { throw error; }, { revalidateMs: 1 });
    await Bun.sleep(5);
    const opens = spyOn(ContainedDirectory, "openExisting");
    try {
      const held = store.inspect();
      opens.mockClear();
      const inspections = Array.from({ length: 20 }, () => store.inspect());
      for (const filename of ["profiles/profile-locks/.profile.work.lock", ".profiles.lock", "profiles/work/auth.json"]) notify("change", filename);
      inspections.push(store.inspect());
      if (HOLDS_DIRECTORY_VALUES) {
        for (const inspection of inspections) expect(inspection).toBe(held);
        expect(opens).not.toHaveBeenCalled();
      } else {
        for (const inspection of inspections) expect(inspection).toEqual(held);
        expect(opens).toHaveBeenCalledTimes(21);
      }

      // Another process renames the profile: the inspection after the watch event reads it.
      writeFileSync(join(root, "auth", "profiles", "work", "profile.json"), JSON.stringify({ displayName: "Renamed" }));
      notify("rename", "profiles/work/profile.json");
      expect(store.inspect().profiles).toEqual([{ id: "work", displayName: "Renamed" }]);

      // A selection this process writes is seen by the next inspection, before any watch event.
      await store.writeStickyProfile("work");
      expect(store.inspect().stickyProfile).toBe("work");

      // Each mutation of a longer operation is seen by the next inspection, before the operation ends.
      await store.withOperation((operation) => {
        operation.create("home", "Home").close();
        expect(store.inspect().profiles.map(({ id }) => id)).toEqual(["home", "work"]);
        operation.writeStickyProfile("home");
        expect(store.inspect().stickyProfile).toBe("home");
        operation.rename("home", "House");
        expect(store.inspect().profiles[0]?.displayName).toBe("House");
      });
    } finally {
      opens.mockRestore();
      watcher.dispose();
      watching.mockRestore();
      controlled.close();
    }
  });

  test("a catalog watch that hears nothing still sees an in-place edit and a replaced auth directory within its revalidation period", async () => {
    const fs = await import("node:fs");
    const root = temporaryDirectory("auth-profile-catalog-silent-");
    const store = new AuthProfileStore(root);
    (await store.create("work", "Work")).close();
    const controlled = fs.watch(root, () => {});
    const watching = spyOn(fs, "watch").mockImplementation(() => controlled);
    const watcher = store.watchCatalog(() => {}, (error) => { throw error; }, { revalidateMs: 5 });
    const opens = spyOn(ContainedDirectory, "openExisting");
    const until = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await Bun.sleep(5);
      expect(predicate()).toBe(true);
    };
    try {
      if (HOLDS_DIRECTORY_VALUES) {
        await until(() => {
          store.inspect();
          opens.mockClear();
          store.inspect();
          return opens.mock.calls.length === 0;
        });
      }
      // The profile's metadata, edited where it is: no directory entry changes.
      writeFileSync(join(root, "auth", "profiles", "work", "profile.json"), JSON.stringify({ displayName: "Edited" }));
      await until(() => store.inspect().profiles[0]?.displayName === "Edited");

      // Another auth directory takes the path: inspections read it, not the one the watch armed on.
      renameSync(join(root, "auth"), join(root, "auth-detached"));
      (await new AuthProfileStore(root).create("home", "Home")).close();
      await until(() => store.inspect().profiles.map(({ id }) => id).join(",") === "home");
    } finally {
      opens.mockRestore();
      watcher.dispose();
      watching.mockRestore();
      controlled.close();
    }
  });

  // Only a held inspection lists the profiles directory ahead of its computation.
  test.if(HOLDS_DIRECTORY_VALUES)("a profile created while the catalog is listed is tracked from the next revalidation", async () => {
    const fs = await import("node:fs");
    const root = temporaryDirectory("auth-profile-catalog-listing-");
    const store = new AuthProfileStore(root);
    (await store.create("work", "Work")).close();
    const profiles = join(root, "auth", "profiles");
    const controlled = fs.watch(root, () => {});
    const watching = spyOn(fs, "watch").mockImplementation(() => controlled);
    const watcher = store.watchCatalog(() => {}, (error) => { throw error; }, { revalidateMs: 5 });
    const list = fs.readdirSync;
    let created = false;
    // Another process creates a profile right after the catalog lists the profiles directory.
    const listing = spyOn(fs, "readdirSync").mockImplementation(new Proxy(list, {
      apply(_target, _receiver, args: Parameters<typeof list>) {
        const entries = list(...args);
        if (!created && args[0] === profiles) {
          created = true;
          mkdirSync(join(profiles, "home"));
          writeFileSync(join(profiles, "home", "profile.json"), JSON.stringify({ displayName: "Home" }));
        }
        return entries;
      },
    }));
    const until = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await Bun.sleep(5);
      expect(predicate()).toBe(true);
    };
    try {
      await Bun.sleep(25);
      expect(store.inspect().profiles.map(({ id }) => id)).toEqual(["home", "work"]);
      // The new profile's metadata, edited where it is: no watch event reports it.
      writeFileSync(join(profiles, "home", "profile.json"), JSON.stringify({ displayName: "Home Edited" }));
      await until(() => store.inspect().profiles[0]?.displayName === "Home Edited");
    } finally {
      listing.mockRestore();
      watcher.dispose();
      watching.mockRestore();
      controlled.close();
    }
  });

  test("watches only the active-profile marker authority", () => {
    const root = temporaryDirectory("auth-profile-store-watcher-");
    const watched: string[] = [];
    const store = new AuthProfileStore(root);
    const watcher = store.watchActiveProfile(() => {}, {
      watchDirectory: (directory) => {
        watched.push(directory);
        return { close: () => {} };
      },
    });

    expect(watched).toEqual([join(root, "auth")]);
    watcher.dispose();
  });

  test("detects an external repair of the selected profile auth file", async () => {
    const root = temporaryDirectory("auth-profile-auth-watcher-");
    const store = new AuthProfileStore(root);
    const access = await store.create("work", "Work");
    access.writeFile("auth.json", "{");
    access.close();
    let changes = 0;
    const watcher = store.watchAuthFile(authDir(root, "work"), () => { changes += 1; }, { debounceMs: 1, revalidateMs: 5 });
    writeFileSync(join(authDir(root, "work"), "auth.json"), "{}");
    await Bun.sleep(20);
    watcher.dispose();
    expect(changes).toBe(1);
  });

  test("detects a same-size byte replacement through contained profile access", async () => {
    const root = temporaryDirectory("auth-profile-auth-watcher-bytes-");
    const store = new AuthProfileStore(root);
    const access = await store.create("work", "Work");
    access.writeFile("auth.json", "{");
    access.close();
    let changes = 0;
    const directory = authDir(root, "work");
    const watcher = store.watchAuthFile(directory, () => { changes += 1; }, { debounceMs: 1, revalidateMs: 5 });

    writeFileSync(join(directory, "replacement"), "}");
    renameSync(join(directory, "replacement"), join(directory, "auth.json"));
    await Bun.sleep(20);

    watcher.dispose();
    expect(changes).toBe(1);
  });

  test("does not follow a replaced profile directory symlink while observing auth bytes", async () => {
    const root = temporaryDirectory("auth-profile-auth-watcher-contained-");
    const target = temporaryDirectory("auth-profile-auth-watcher-target-");
    const store = new AuthProfileStore(root);
    const access = await store.create("work", "Work");
    access.writeFile("auth.json", "{}");
    access.close();
    const directory = authDir(root, "work");
    let changes = 0;
    const watcher = store.watchAuthFile(directory, () => { changes += 1; }, { debounceMs: 1, revalidateMs: 5 });

    renameSync(directory, `${directory}-detached`);
    symlinkSync(target, directory);
    writeFileSync(join(target, "auth.json"), "[]");
    await Bun.sleep(20);

    watcher.dispose();
    rmSync(directory);
    expect(changes).toBe(0);
  });

  test("refuses symlinks at auth, profile, marker, and manifest boundaries", async () => {
    const target = temporaryDirectory("auth-profile-target-");

    const authRoot = temporaryDirectory("auth-profile-store-");
    symlinkSync(target, join(authRoot, "auth"));
    await expect(new AuthProfileStore(authRoot).list()).rejects.toThrow(ContainedPathError);

    const profileRoot = temporaryDirectory("auth-profile-store-");
    mkdirSync(join(profileRoot, "auth", "profiles"), { recursive: true });
    symlinkSync(target, join(profileRoot, "auth", "profiles", "linked"));
    await expect(new AuthProfileStore(profileRoot).open("linked")).rejects.toThrow(ContainedPathError);

    const metadataRoot = temporaryDirectory("auth-profile-store-");
    const metadataStore = new AuthProfileStore(metadataRoot);
    const access = await metadataStore.create("work", "Work");
    access.close();
    symlinkSync(join(target, "marker"), join(metadataRoot, "auth", ".active-profile"));
    await expect(metadataStore.readStickyProfile()).rejects.toThrow(ContainedPathError);
    renameSync(join(metadataRoot, "auth", ".active-profile"), join(metadataRoot, "auth", "profiles", "work", "profile.json"));
    await expect(metadataStore.list()).rejects.toThrow(ContainedPathError);
  });
});
