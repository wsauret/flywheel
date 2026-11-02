import type { ServeLane } from "../../../infra/cli-subprocess.js";
import { mkdirSync, watch as watchDirectory } from "node:fs";
import { Redacted, Schema } from "effect";
import { accountAuthDir, accountSecretFile } from "../../../infra/paths.js";
import { readLockedJsonStore, mutateLockedJsonStore, type LockedJsonStoreOptions } from "../../../infra/auth/locked-json-store.js";
import type { AccountProjectRegistry } from "../../app-service/account-project-registry.js";
import type { RemotePushSubscription } from "../../../protocol/modules/remote.js";

/** The account's remote-access facts: which relay it pairs against, the one
 *  identity key every placement of this account presents to that relay, the
 *  Web Push signing key, and the devices the user has paired.
 *
 *  This is account state, not project state: a phone is paired to a person's
 *  machine, and every project that machine serves is reachable through the
 *  same pairing. It lives beside `auth.json` under the same locked, contained,
 *  private-file discipline, because the identity key is a credential: whoever
 *  holds it can present this account to the relay.
 *
 *  Private keys are `Redacted` from the moment they are decoded. The one place
 *  that sees them in the clear is the `encode` below, which is this store's
 *  serialization boundary. Key generation and signing live with the remote
 *  access service; this module only keeps what it is given. */

/** Each lane keeps its own relay identity and pairings. The installed store owns
 *  the machine's VAPID key in its release-compatible version-2 shape.
 *  The machine-wide push store owns subscriptions independently of pairings. */
const storeFile = (lane: ServeLane): string => lane === "installed" ? "remote.json" : "remote-dev.json";
const pushStoreFile = "remote-push.json";

const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

/** The `PushSubscriptionJSON` shape a browser hands out, kept as the browser
 *  spells it so the runtime can post to the endpoint without a translation. */
const PushSubscriptionSchema = Schema.Struct({
  endpoint: Schema.String,
  expirationTime: Schema.NullOr(Schema.Number),
  keys: Schema.Struct({ p256dh: Base64Url, auth: Base64Url }),
});

const PairedDeviceSchema = Schema.Struct({
  id: Base64Url,
  label: Schema.NonEmptyString,
  publicKey: Base64Url,
  pairedAt: Schema.Number,
  // Remove this conversion field after 2027-04-24: earlier releases stored subscriptions on pairings.
  pushSubscription: Schema.optionalKey(PushSubscriptionSchema),
});
export type PairedDevice = typeof PairedDeviceSchema.Type;

const PlacementRecordSchema = Schema.Struct({
  projectRoot: Schema.NonEmptyString,
  projectLabel: Schema.NonEmptyString,
  lastAttachedAt: Schema.Number,
});
type LegacyRemotePlacementRecord = typeof PlacementRecordSchema.Type;

const PersistedRemoteStoreV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  /** Absent until the user pairs against a relay; the hosted default applies. */
  relayUrl: Schema.optionalKey(Schema.NonEmptyString),
  identity: Schema.optionalKey(Schema.Struct({ publicKey: Base64Url, privateKey: Base64Url })),
  vapid: Schema.optionalKey(Schema.Struct({ publicKey: Base64Url, privateKey: Base64Url })),
  devices: Schema.Array(PairedDeviceSchema),
  placements: Schema.optionalKey(Schema.Array(PlacementRecordSchema)),
});
const PersistedRemoteStoreSchema = Schema.Struct({
  version: Schema.Literal(2),
  relayUrl: Schema.optionalKey(Schema.NonEmptyString),
  identity: Schema.optionalKey(Schema.Struct({ publicKey: Base64Url, privateKey: Base64Url })),
  vapid: Schema.optionalKey(Schema.Struct({ publicKey: Base64Url, privateKey: Base64Url })),
  devices: Schema.Array(PairedDeviceSchema),
});
type PersistedRemoteStore = typeof PersistedRemoteStoreSchema.Type;
type DecodedRemoteStore = { readonly store: RemotePairingStore; readonly legacyPlacements: readonly LegacyRemotePlacementRecord[] };
const decodePersisted = Schema.decodeUnknownSync(Schema.Union([PersistedRemoteStoreV1Schema, PersistedRemoteStoreSchema]), { onExcessProperty: "error" });
const decodePushStore = Schema.decodeUnknownSync(Schema.Struct({
  version: Schema.Literal(1),
  subscriptions: Schema.Record(Base64Url, PushSubscriptionSchema),
}), { onExcessProperty: "error" });

interface RemotePushStore {
  subscriptions: Map<string, RemotePushSubscription>;
}

/** An asymmetric key pair as the store holds it: the public half is plain and
 *  the private half is redacted. Both are base64url of the WebCrypto export,
 *  raw for the public key and PKCS#8 for the private key. */
export interface StoredKeyPair {
  readonly publicKey: string;
  readonly privateKey: Redacted.Redacted<string>;
}

export interface RemotePairingStore {
  relayUrl: string | undefined;
  identity: StoredKeyPair | undefined;
  vapid: StoredKeyPair | undefined;
  devices: PairedDevice[];
}

function emptyStore(): RemotePairingStore {
  return { relayUrl: undefined, identity: undefined, vapid: undefined, devices: [] };
}

function fromPersisted(persisted: ReturnType<typeof decodePersisted>): DecodedRemoteStore {
  const redact = (pair: { readonly publicKey: string; readonly privateKey: string } | undefined): StoredKeyPair | undefined =>
    pair === undefined ? undefined : { publicKey: pair.publicKey, privateKey: Redacted.make(pair.privateKey) };
  return {
    store: {
      relayUrl: persisted.relayUrl,
      identity: redact(persisted.identity),
      vapid: redact(persisted.vapid),
      devices: [...persisted.devices],
    },
    legacyPlacements: persisted.version === 1 ? [...(persisted.placements ?? [])] : [],
  };
}

/** The serialization boundary: the only line that unwraps a private key. */
function toPersisted(store: RemotePairingStore): PersistedRemoteStore {
  const expose = (pair: StoredKeyPair) => ({ publicKey: pair.publicKey, privateKey: Redacted.value(pair.privateKey) });
  return {
    version: 2,
    ...(store.relayUrl === undefined ? {} : { relayUrl: store.relayUrl }),
    ...(store.identity === undefined ? {} : { identity: expose(store.identity) }),
    ...(store.vapid === undefined ? {} : { vapid: expose(store.vapid) }),
    devices: store.devices,
  };
}

function storeOptions(userDataRoot: string, lane: ServeLane): LockedJsonStoreOptions<RemotePairingStore> {
  return {
    location: accountSecretFile(accountAuthDir(userDataRoot), storeFile(lane)),
    empty: emptyStore,
    decode: (value) => fromPersisted(decodePersisted(value)).store,
    encode: toPersisted,
  };
}

function migrationStoreOptions(userDataRoot: string, lane: ServeLane): LockedJsonStoreOptions<DecodedRemoteStore> {
  return {
    location: accountSecretFile(accountAuthDir(userDataRoot), storeFile(lane)),
    empty: () => ({ store: emptyStore(), legacyPlacements: [] }),
    decode: (value) => fromPersisted(decodePersisted(value)),
    encode: ({ store }) => toPersisted(store),
  };
}

class MalformedRemotePairingStoreError extends Error {
  readonly _tag = "MalformedRemotePairingStoreError" as const;
}

/** Reads the store. An absent file is the empty store; a
 *  malformed one is an error the caller reports, because silently starting
 *  over would unpair every device without a word. */
export function readRemotePairingStore(userDataRoot: string, lane: ServeLane): RemotePairingStore {
  const state = readLockedJsonStore(storeOptions(userDataRoot, lane));
  if (state.tag === "valid") return state.value;
  if (state.tag === "malformed") throw new MalformedRemotePairingStoreError(`The remote pairing store under ${userDataRoot} is not valid JSON in the expected shape. Repair or move it and try again.`);
  return emptyStore();
}

/** Changes the lane's store under its lock, then tells this process's readers (`onRemoteStoresWritten`). */
export async function mutateRemotePairingStore(userDataRoot: string, lane: ServeLane, mutate: (store: RemotePairingStore) => void | Promise<void>): Promise<void> {
  await mutateLockedJsonStore(storeOptions(userDataRoot, lane), mutate);
  announceWrite(userDataRoot);
}

function pushStoreOptions(userDataRoot: string): LockedJsonStoreOptions<RemotePushStore> {
  return {
    location: accountSecretFile(accountAuthDir(userDataRoot), pushStoreFile),
    empty: () => {
      // Remove this conversion after 2027-04-24. Creation adopts once under the push-store lock.
      // A dev subscription is valid only under the shared key. A different key needs phone registration again.
      // Older installed releases may still use remote.json, so dev never strips its records.
      // Writes by those releases after creation are not adopted; removal must never resurrect a subscription.
      const installed = readRemotePairingStore(userDataRoot, "installed");
      const dev = readRemotePairingStore(userDataRoot, "dev");
      const subscriptions = new Map<string, RemotePushSubscription>();
      for (const device of installed.devices) {
        if (device.pushSubscription !== undefined) subscriptions.set(device.id, device.pushSubscription);
      }
      if (dev.vapid !== undefined && dev.vapid.publicKey === installed.vapid?.publicKey) {
        for (const device of dev.devices) {
          if (device.pushSubscription !== undefined && !subscriptions.has(device.id)) subscriptions.set(device.id, device.pushSubscription);
        }
      }
      return { subscriptions };
    },
    decode: (value) => ({ subscriptions: new Map(Object.entries(decodePushStore(value).subscriptions)) }),
    encode: (store) => ({ version: 1, subscriptions: Object.fromEntries(store.subscriptions) }),
  };
}

/** Reads machine-wide subscriptions. An unreadable file is an error, never an empty replacement. */
export function readRemotePushStore(userDataRoot: string): RemotePushStore {
  const state = readLockedJsonStore(pushStoreOptions(userDataRoot));
  if (state.tag === "valid") return state.value;
  if (state.tag === "malformed") throw new MalformedRemotePairingStoreError(`The remote push store under ${userDataRoot} is not valid JSON in the expected shape. Repair or move it and try again.`);
  return { subscriptions: new Map() };
}

/** Changes subscriptions under the machine-wide credential lock, independently of lane pairings, then tells this process's readers. */
export async function mutateRemotePushStore(userDataRoot: string, mutate: (store: RemotePushStore) => void): Promise<void> {
  await mutateLockedJsonStore(pushStoreOptions(userDataRoot), mutate);
  announceWrite(userDataRoot);
}

/** Converts previous lane subscriptions once and removes only this lane's obsolete fields. */
export async function importLegacyRemotePushSubscriptions(userDataRoot: string, lane: ServeLane): Promise<void> {
  // Remove this conversion after 2027-04-24. Both lanes must import before dev drops its previous key.
  const state = readLockedJsonStore(pushStoreOptions(userDataRoot));
  if (state.tag === "malformed") throw new MalformedRemotePairingStoreError(`The remote push store under ${userDataRoot} is not valid JSON in the expected shape. Repair or move it and try again.`);
  if (state.tag === "absent") await mutateRemotePushStore(userDataRoot, () => {});
  if (readRemotePairingStore(userDataRoot, lane).devices.some((device) => device.pushSubscription !== undefined)) {
    await mutateRemotePairingStore(userDataRoot, lane, (store) => {
      store.devices = store.devices.map(({ id, label, publicKey, pairedAt }) => ({ id, label, publicKey, pairedAt }));
    });
  }
}

/** Imports version-1 placement rows into their sole current authority, then rewrites the credential store in the current shape. */
export async function importLegacyRemotePlacements(userDataRoot: string, lane: ServeLane, registry: Pick<AccountProjectRegistry, "record" | "list">): Promise<void> {
  const state = readLockedJsonStore(migrationStoreOptions(userDataRoot, lane));
  if (state.tag === "malformed") throw new MalformedRemotePairingStoreError(`The remote pairing store under ${userDataRoot} is not valid JSON in the expected shape. Repair or move it and try again.`);
  if (state.tag !== "valid" || state.value.legacyPlacements.length === 0) return;
  for (const placement of state.value.legacyPlacements) {
    if ((await registry.list()).some((project) => project.projectRoot === placement.projectRoot)) continue;
    await registry.record({ projectRoot: placement.projectRoot, label: placement.projectLabel, lastAttachedAt: placement.lastAttachedAt });
  }
  await mutateRemotePairingStore(userDataRoot, lane, () => {});
}

/** Every store write this process commits, by account. One account service
 *  process holds a placement for each open project and the account's relay
 *  service, and each keeps its own view of the devices: a revoke through one
 *  must close the device's channels in all of them at once. A file watch
 *  cannot carry that, because the platform delays and drops its events
 *  under load, so the write path itself tells the readers of its process. */
const writeListeners = new Map<string, Set<() => void>>();

function announceWrite(userDataRoot: string): void {
  for (const listener of writeListeners.get(userDataRoot) ?? []) listener();
}

/** Calls `onWrite` after each pairing or push store write that this process
 *  commits for the account, until the returned disposer runs. Writes by other
 *  processes do not reach it: the account service is the one live writer of
 *  its lane's pairings, and `flywheel remote` sends every change to it. */
export function onRemoteStoresWritten(userDataRoot: string, onWrite: () => void): () => void {
  const listeners = writeListeners.get(userDataRoot) ?? new Set<() => void>();
  writeListeners.set(userDataRoot, listeners);
  listeners.add(onWrite);
  return () => {
    listeners.delete(onWrite);
    if (listeners.size === 0) writeListeners.delete(userDataRoot);
  };
}

/** A subscription another lane's service writes lands in the shared file;
 *  a watcher notices within this window. */
const WATCH_DEBOUNCE_MS = 250;

/** Calls `onChange` after the machine-wide push store file changes, debounced,
 *  until the returned disposer runs. Each lane's account service is its own
 *  process, and both record and remove the subscriptions of the same phones in
 *  this one file, so a lane learns of the other lane's writes only through the
 *  file. A dropped event leaves the subscription unseen until the next reload.
 *  Throws when the platform cannot watch the directory; the caller decides
 *  whether that matters. */
export function watchRemotePushStore(userDataRoot: string, onChange: () => void): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const directory = accountAuthDir(userDataRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const watcher = watchDirectory(directory, (_event, file) => {
    if (file !== null && !String(file).startsWith(pushStoreFile)) return;
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      if (!closed) onChange();
    }, WATCH_DEBOUNCE_MS);
    pending.unref?.();
  });
  watcher.on("error", () => {});
  watcher.unref();
  return () => {
    closed = true;
    if (pending !== undefined) clearTimeout(pending);
    watcher.close();
  };
}
