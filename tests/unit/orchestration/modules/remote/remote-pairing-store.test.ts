import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted, Schema } from "effect";

import { createAccountProjectRegistry } from "../../../../../src/orchestration/app-service/account-project-registry.js";
import { importLegacyRemotePlacements, mutateRemotePairingStore, mutateRemotePushStore, readRemotePairingStore, readRemotePushStore } from "../../../../../src/orchestration/modules/remote/remote-pairing-store.js";
import { ensureRemoteIdentity, remoteIdentityFrom } from "../../../../../src/orchestration/modules/remote/remote-identity.js";
import { asKeyPair, keyDigest, toBase64Url } from "../../../../../src/protocol/modules/remote/relay-protocol.js";

const ReleaseBase64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const ReleaseKeyPair = Schema.Struct({ publicKey: ReleaseBase64Url, privateKey: ReleaseBase64Url });
const decodeReleaseV2 = Schema.decodeUnknownSync(Schema.Struct({
  version: Schema.Literal(2),
  relayUrl: Schema.optionalKey(Schema.NonEmptyString),
  identity: Schema.optionalKey(ReleaseKeyPair),
  vapid: Schema.optionalKey(ReleaseKeyPair),
  devices: Schema.Array(Schema.Struct({
    id: ReleaseBase64Url,
    label: Schema.NonEmptyString,
    publicKey: ReleaseBase64Url,
    pairedAt: Schema.Number,
    pushSubscription: Schema.optionalKey(Schema.Struct({
      endpoint: Schema.String,
      expirationTime: Schema.NullOr(Schema.Number),
      keys: Schema.Struct({ p256dh: ReleaseBase64Url, auth: ReleaseBase64Url }),
    })),
  })),
}), { onExcessProperty: "error" });

/** The pairing store is a credential file: the identity key in it is what
 *  presents this account to the relay. These tests hold it to the same rules
 *  as auth.json: private on disk, redacted in memory, stable across reads,
 *  and generated exactly once. */

function withUserData<T>(run: (userDataRoot: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-remote-store-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("remote pairing store", () => {
  test("an absent store is empty and names no relay", () =>
    withUserData(async (root) => {
      const store = readRemotePairingStore(root, "installed");
      expect(store).toEqual({ relayUrl: undefined, identity: undefined, vapid: undefined, devices: [] });
    }));

  test("generates one identity and one VAPID key on first use and keeps them", () =>
    withUserData(async (root) => {
      const [first, second] = await Promise.all([ensureRemoteIdentity(root, "installed"), ensureRemoteIdentity(root, "installed")]);
      expect(second.runtimeId).toBe(first.runtimeId);
      expect(first.runtimeId).toBe(await keyDigest(first.publicKey));
      const store = readRemotePairingStore(root, "installed");
      expect(store.identity?.publicKey).toBeDefined();
      expect(store.vapid?.publicKey).toBeDefined();
      const signature = await first.sign(new TextEncoder().encode("hello"));
      expect(signature.byteLength).toBe(64);
    }));

  test("keeps the private keys redacted in memory and out of JSON.stringify", () =>
    withUserData(async (root) => {
      await ensureRemoteIdentity(root, "installed");
      const store = readRemotePairingStore(root, "installed");
      const onDisk = readFileSync(join(root, "auth", "remote.json"), "utf8");
      const privateKey = Redacted.value(store.identity!.privateKey);
      expect(Redacted.isRedacted(store.identity!.privateKey)).toBe(true);
      expect(privateKey.length).toBeGreaterThan(40);
      expect(onDisk).toContain(privateKey);
      expect(JSON.stringify(store)).not.toContain(privateKey);
    }));

  test("writes the file private to the account", () =>
    withUserData(async (root) => {
      await ensureRemoteIdentity(root, "installed");
      if (process.platform === "win32") return;
      expect(statSync(join(root, "auth", "remote.json")).mode & 0o077).toBe(0);
      expect(statSync(join(root, "auth", "remote-push.json")).mode & 0o077).toBe(0);
      expect(statSync(join(root, "auth")).mode & 0o077).toBe(0);
    }));

  test("records and revokes paired devices under the lock", () =>
    withUserData(async (root) => {
      await ensureRemoteIdentity(root, "installed");
      await mutateRemotePairingStore(root, "installed", (store) => {
        store.devices.push({ id: "dev1", label: "phone", publicKey: "AAAA", pairedAt: 1 });
        store.relayUrl = "wss://relay.example.test";
      });
      expect(readRemotePairingStore(root, "installed").devices).toEqual([{ id: "dev1", label: "phone", publicKey: "AAAA", pairedAt: 1 }]);
      expect(readRemotePairingStore(root, "installed").relayUrl).toBe("wss://relay.example.test");
      await mutateRemotePairingStore(root, "installed", (store) => { store.devices = store.devices.filter((device) => device.id !== "dev1"); });
      expect(readRemotePairingStore(root, "installed").devices).toEqual([]);
      // The identity survives every device mutation.
      expect((await remoteIdentityFrom(readRemotePairingStore(root, "installed"))).runtimeId).toBeDefined();
    }));

  test.each(["installed", "dev"] as const)("imports each version-1 %s placement once and current writes omit placements", (lane) =>
    withUserData(async (root) => {
      await ensureRemoteIdentity(root, lane);
      const path = join(root, "auth", lane === "installed" ? "remote.json" : "remote-dev.json");
      const persisted = JSON.parse(readFileSync(path, "utf8"));
      // The registry forgets a project whose directory is gone, so each
      // placement names a directory that exists.
      const projectDirectory = (name: string): string => {
        mkdirSync(join(root, "work", name), { recursive: true });
        return realpathSync(join(root, "work", name));
      };
      const flywheel = projectDirectory("flywheel");
      const other = projectDirectory("other");
      persisted.version = 1;
      persisted.placements = [
        { projectRoot: flywheel, projectLabel: "flywheel", lastAttachedAt: 5 },
        { projectRoot: other, projectLabel: "other", lastAttachedAt: 6 },
      ];
      await Bun.write(path, JSON.stringify(persisted));
      const registry = createAccountProjectRegistry({ userDataRoot: root });
      try {
        await Promise.all([
          importLegacyRemotePlacements(root, lane, registry),
          importLegacyRemotePlacements(root, lane, registry),
        ]);
        expect((await registry.list()).map(({ projectRoot, label, lastAttachedAt }) => ({ projectRoot, label, lastAttachedAt }))).toEqual([
          { projectRoot: flywheel, label: "flywheel", lastAttachedAt: 5 },
          { projectRoot: other, label: "other", lastAttachedAt: 6 },
        ]);
        await mutateRemotePairingStore(root, lane, () => {});
        expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("placements");
        expect((await remoteIdentityFrom(readRemotePairingStore(root, lane))).runtimeId).toBeDefined();
      } finally {
        await registry.dispose();
      }
    }));

  test("refuses a malformed store instead of starting over", () =>
    withUserData(async (root) => {
      await ensureRemoteIdentity(root, "installed");
      await mutateRemotePairingStore(root, "installed", () => {});
      const path = join(root, "auth", "remote.json");
      await Bun.write(path, "{ not json");
      expect(() => readRemotePairingStore(root, "installed")).toThrow(/not valid JSON/);
    }));

  test("each lane keeps its identity and devices but shares the installed store's VAPID key", () =>
    withUserData(async (root) => {
      await mutateRemotePairingStore(root, "dev", (store) => {
        store.devices = [{ id: "dev1", label: "phone", publicKey: "a", pairedAt: 1 }];
      });
      expect(statSync(join(root, "auth", "remote-dev.json")).isFile()).toBe(true);
      expect(readRemotePairingStore(root, "dev").devices).toHaveLength(1);
      expect(readRemotePairingStore(root, "installed").devices).toEqual([]);
      const dev = await ensureRemoteIdentity(root, "dev");
      const pushKey = readRemotePairingStore(root, "installed").vapid?.publicKey;
      const [installed] = await Promise.all([ensureRemoteIdentity(root, "installed"), ensureRemoteIdentity(root, "dev")]);
      expect(dev.runtimeId).not.toBe(installed.runtimeId);
      expect(pushKey).toBeDefined();
      expect(readRemotePairingStore(root, "installed").vapid?.publicKey).toBe(pushKey);
      expect(readRemotePairingStore(root, "dev").vapid).toBeUndefined();
    }));

  test("adopts the previous lane's VAPID key before generating one for another lane", () =>
    withUserData(async (root) => {
      await ensureRemoteIdentity(root, "dev");
      const previous = JSON.parse(readFileSync(join(root, "auth", "remote-dev.json"), "utf8"));
      previous.version = 2;
      const pair = asKeyPair(await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
      previous.vapid = {
        publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
        privateKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
      };
      const subscription = { endpoint: "https://push.test/adopted", expirationTime: null, keys: { p256dh: "key", auth: "auth" } };
      previous.devices = [{ id: "phone", label: "Phone", publicKey: "AAAA", pairedAt: 1, pushSubscription: subscription }];
      // A version-2 lane is the only credential file an existing installation has.
      const otherRoot = mkdtempSync(join(tmpdir(), "flywheel-remote-legacy-"));
      try {
        mkdirSync(join(otherRoot, "auth"), { mode: 0o700 });
        await Bun.write(join(otherRoot, "auth", "remote-dev.json"), JSON.stringify(previous));
        await ensureRemoteIdentity(otherRoot, "installed");
        expect(readRemotePairingStore(otherRoot, "installed").vapid?.publicKey).toBe(previous.vapid.publicKey);
        expect(JSON.parse(readFileSync(join(otherRoot, "auth", "remote-push.json"), "utf8")).subscriptions).toEqual({ phone: subscription });
        await ensureRemoteIdentity(otherRoot, "dev");
        expect(readRemotePairingStore(otherRoot, "installed").vapid?.publicKey).toBe(previous.vapid.publicKey);
        expect(JSON.parse(readFileSync(join(otherRoot, "auth", "remote-dev.json"), "utf8"))).not.toHaveProperty("vapid");
        expect(Redacted.value(readRemotePairingStore(otherRoot, "installed").vapid!.privateKey)).toBe(previous.vapid.privateKey);
      } finally { rmSync(otherRoot, { recursive: true, force: true }); }
    }));

  test.each([1, 2] as const)("converts version-%s subscriptions once without letting dev strip installed credentials", (version) =>
    withUserData(async (root) => {
      await ensureRemoteIdentity(root, "installed");
      await ensureRemoteIdentity(root, "dev");
      const installedPath = join(root, "auth", "remote.json");
      const devPath = join(root, "auth", "remote-dev.json");
      const installed = JSON.parse(readFileSync(installedPath, "utf8"));
      const dev = JSON.parse(readFileSync(devPath, "utf8"));
      const device = { id: "phone", label: "installed phone", publicKey: "AAAA", pairedAt: 1 };
      const installedSubscription = { endpoint: "https://push.test/installed", expirationTime: null, keys: { p256dh: "key", auth: "auth" } };
      const devSubscription = { ...installedSubscription, endpoint: "https://push.test/dev" };
      installed.version = version;
      dev.version = version;
      installed.devices = [{ ...device, pushSubscription: installedSubscription }];
      dev.vapid = installed.vapid;
      dev.devices = [{ ...device, label: "dev phone", pushSubscription: devSubscription }];
      await Bun.write(installedPath, JSON.stringify(installed));
      await Bun.write(devPath, JSON.stringify(dev));
      rmSync(join(root, "auth", "remote-push.json"), { force: true });
      await ensureRemoteIdentity(root, "dev");
      const shared = JSON.parse(readFileSync(installedPath, "utf8"));
      const lane = JSON.parse(readFileSync(devPath, "utf8"));
      expect(shared).toEqual(installed);
      expect(JSON.parse(readFileSync(join(root, "auth", "remote-push.json"), "utf8")).subscriptions).toEqual({ phone: installedSubscription });
      expect(lane.devices).toEqual([{ ...device, label: "dev phone" }]);
      expect(lane.identity).toEqual(dev.identity);
      await mutateRemotePushStore(root, (store) => { store.subscriptions.delete("phone"); });
      await ensureRemoteIdentity(root, "dev");
      expect(readRemotePushStore(root).subscriptions).toEqual(new Map());
      expect(JSON.parse(readFileSync(installedPath, "utf8"))).toEqual(installed);
      await ensureRemoteIdentity(root, "installed");
      expect(decodeReleaseV2(JSON.parse(readFileSync(installedPath, "utf8"))).devices).toEqual([device]);
    }));

  test.each(["installed", "dev"] as const)("keeps %s writes readable by the installed release's version-2 schema", (lane) =>
    withUserData(async (root) => {
      const subscription = { endpoint: "https://push.test/phone", expirationTime: null, keys: { p256dh: "key", auth: "auth" } };
      const device = { id: "phone", label: "Phone", publicKey: "AAAA", pairedAt: 1, pushSubscription: subscription };
      mkdirSync(join(root, "auth"), { mode: 0o700 });
      await Bun.write(join(root, "auth", "remote.json"), JSON.stringify({ version: 2, devices: [device] }));
      await ensureRemoteIdentity(root, lane);
      const installed = decodeReleaseV2(JSON.parse(readFileSync(join(root, "auth", "remote.json"), "utf8")));
      expect(installed.vapid).toBeDefined();
      expect(installed.devices[0]?.pushSubscription).toEqual(lane === "dev" ? subscription : undefined);
      expect(readRemotePushStore(root).subscriptions).toEqual(new Map([["phone", subscription]]));
      await mutateRemotePairingStore(root, lane, (store) => {
        store.devices = [device];
      });
      const persisted = JSON.parse(readFileSync(join(root, "auth", lane === "installed" ? "remote.json" : "remote-dev.json"), "utf8"));
      expect(decodeReleaseV2(persisted).devices[0]?.pushSubscription).toEqual(subscription);
    }));

  test.each(["matching", "distinct"] as const)("converts a dev-only subscription with a %s previous key", (key) =>
    withUserData(async (root) => {
      await ensureRemoteIdentity(root, "dev");
      const path = join(root, "auth", "remote-dev.json");
      const previous = JSON.parse(readFileSync(path, "utf8"));
      previous.version = 2;
      const device = {
        id: "phone", label: "Phone", publicKey: "AAAA", pairedAt: 1,
        pushSubscription: { endpoint: "https://push.test/dev", expirationTime: null, keys: { p256dh: "key", auth: "auth" } },
      };
      previous.devices = [device];
      const sharedKey = readRemotePairingStore(root, "installed").vapid!;
      previous.vapid = key === "matching"
        ? { publicKey: sharedKey.publicKey, privateKey: Redacted.value(sharedKey.privateKey) }
        : { publicKey: "different", privateKey: "different" };
      await Bun.write(path, JSON.stringify(previous));
      rmSync(join(root, "auth", "remote-push.json"), { force: true });
      await ensureRemoteIdentity(root, "dev");
      expect(JSON.parse(readFileSync(join(root, "auth", "remote-push.json"), "utf8")).subscriptions).toEqual(key === "matching" ? { phone: device.pushSubscription } : {});
      expect(decodeReleaseV2(JSON.parse(readFileSync(path, "utf8"))).devices).toEqual([{ id: "phone", label: "Phone", publicKey: "AAAA", pairedAt: 1 }]);
    }));
});
