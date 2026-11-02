import { expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  replaceRejectedProviderCredentials,
  replaceRejectedProviderCredentialsWithReceipt,
  rollbackAuthStoreMutation,
} from "../src/infra/auth/auth-store-mutations.js";

const classify = (id: string) => id === "subscription" ? "subscription" as const : "metered" as const;
const credential = { type: "api_key" as const, key: "fixture-replacement-only" };
const account = (id: string, identity: string) => ({
  id, identity, lineageId: crypto.randomUUID(), credential: { type: "api_key", key: "fixture-account-only" },
});

async function withStore(store: Record<string, unknown>, use: (directory: string, file: string, before: Buffer) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "auth-battery-"));
  try {
    const directory = join(home, "auth");
    await mkdir(directory);
    const file = join(directory, "auth.json");
    const before = Buffer.from(JSON.stringify(store, null, 2) + "\n");
    await writeFile(file, before, { mode: 0o600 });
    await use(directory, file, before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

it("restores a rejected entry after settlement failure without losing newer siblings", async () => {
  const rejected = { type: "api_key", key: 5, recovery: { original: true } };
  const unknown = { nested: ["preserve", { value: 42 }] };
  await withStore({ metered: rejected, retired: unknown, subscription: [account("a", "A")] }, async (directory, file) => {
    const receipt = await replaceRejectedProviderCredentialsWithReceipt("metered", credential, directory, classify);
    expect(receipt).toBeDefined();
    if (!receipt) return;
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(receipt.before).toEqual(rejected);
    expect(receipt.after).toEqual(written.metered);
    expect(written.retired).toEqual(unknown);
    const newerSibling = [account("b", "B"), account("a", "A")];
    const concurrent = { ...written, subscription: newerSibling, retired: { ...unknown, later: true } };
    await writeFile(file, JSON.stringify(concurrent, null, 2) + "\n");
    expect(await rollbackAuthStoreMutation(receipt, directory, classify)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...concurrent, metered: rejected });
    const restored = await readFile(file);
    expect(await rollbackAuthStoreMutation(receipt, directory, classify)).toBe(false);
    expect(await readFile(file)).toEqual(restored);
  });
});

it("refuses rollback over a reconnect with identical credentials and a new lineage", async () => {
  await withStore({ metered: { broken: true }, retired: { opaque: true } }, async (directory, file) => {
    const receipt = await replaceRejectedProviderCredentialsWithReceipt("metered", credential, directory, classify);
    expect(receipt).toBeDefined();
    if (!receipt) return;
    const written = JSON.parse(await readFile(file, "utf8"));
    written.metered.lineageId = crypto.randomUUID();
    const current = Buffer.from(JSON.stringify(written, null, 2) + "\n");
    await writeFile(file, current);
    expect(await rollbackAuthStoreMutation(receipt, directory, classify)).toBe(false);
    expect(await readFile(file)).toEqual(current);
  });
});

it("does not issue a repair receipt for conflicting subscription identities", async () => {
  await withStore({
    subscription: [account("a", "Same"), account("b", "Same")],
    retired: { opaque: true },
  }, async (directory, file, before) => {
    expect(await replaceRejectedProviderCredentialsWithReceipt("subscription", [account("c", "C")], directory, classify)).toBeUndefined();
    expect(await readFile(file)).toEqual(before);
  });
});

it("refuses an aborted repair before any durable write", async () => {
  await withStore({ metered: { broken: true } }, async (directory, file, before) => {
    const controller = new AbortController();
    const reason = new Error("fixture cancelled");
    controller.abort(reason);
    let caught: unknown;
    try {
      await replaceRejectedProviderCredentialsWithReceipt("metered", credential, directory, classify, controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(await readFile(file)).toEqual(before);
  });
});
