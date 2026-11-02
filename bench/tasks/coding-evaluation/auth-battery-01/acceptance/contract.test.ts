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

for (const variant of [
  { name: "boolean", mutate: replaceRejectedProviderCredentials, unchanged: false },
  { name: "receipt", mutate: replaceRejectedProviderCredentialsWithReceipt, unchanged: undefined },
]) {
  it(`${variant.name} preserves a collection with no surviving accounts`, async () => {
    await withStore({
      subscription: [
        { ...account("a", "A"), credential: { type: "api_key", key: 12 } },
        { ...account("b", "B"), identity: "" },
      ],
      retired: { opaque: ["keep", 7] },
    }, async (directory, file, before) => {
      const result = await variant.mutate("subscription", [account("new", "New")], directory, classify);
      expect(await readFile(file)).toEqual(before);
      expect(result).toBe(variant.unchanged);
    });
  });

  it(`${variant.name} preserves empty and retired legacy collections`, async () => {
    for (const collection of [[], [account("legacy", "Legacy")]]) {
      await withStore({ subscription: collection }, async (directory, file, before) => {
        const result = await variant.mutate("subscription", [account("new", "New")], directory, classify);
        expect(await readFile(file)).toEqual(before);
        expect(result).toBe(variant.unchanged);
      });
    }
  });

  it(`${variant.name} repairs a wrong-slot object without renewing unrelated accounts`, async () => {
    const rejected = { type: "api_key", key: "fixture-wrong-slot-only" };
    const other = { type: "api_key", key: "fixture-unrelated-only", lineageId: crypto.randomUUID() };
    const replacement = [account("new", "New")];
    const priorLineage = replacement[0].lineageId;
    await withStore({ subscription: rejected, metered: other, retired: { preserve: true } }, async (directory, file) => {
      const result = await variant.mutate("subscription", replacement, directory, classify);
      const stored = JSON.parse(await readFile(file, "utf8"));
      expect(stored.subscription).toEqual([{ ...replacement[0], lineageId: expect.any(String) }]);
      expect(stored.subscription[0].lineageId).not.toBe(priorLineage);
      expect(replacement[0].lineageId).toBe(priorLineage);
      expect(stored.metered).toEqual(other);
      expect(stored.retired).toEqual({ preserve: true });
      if (variant.name === "receipt") expect(result).toEqual({ providerId: "subscription", before: rejected, after: stored.subscription });
      else expect(result).toBe(true);
    });
  });

  it(`${variant.name} repairs an array rejected by a metered slot`, async () => {
    const rejected = [account("a", "A")];
    await withStore({ metered: rejected, subscription: [] }, async (directory, file) => {
      const result = await variant.mutate("metered", credential, directory, classify);
      const stored = JSON.parse(await readFile(file, "utf8"));
      expect(stored.metered).toEqual({ ...credential, lineageId: expect.any(String) });
      expect(stored.subscription).toEqual([]);
      if (variant.name === "receipt") expect(result).toEqual({ providerId: "metered", before: rejected, after: stored.metered });
      else expect(result).toBe(true);
    });
  });
}
