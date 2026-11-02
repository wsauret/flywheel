import { mkdir } from "node:fs/promises";
import { Schema } from "effect";
import { createJsonFile, createJsonLinesLedger, readJsonFile } from "./json-lines.js";

/** Open a versioned campaign and its strict append-only event ledger. Family owners validate identity and event relationships. */
export async function openCampaignLedger<M, E>(directory: string, family: {
  readonly manifest: Schema.Decoder<M>;
  readonly events: Schema.Decoder<E>;
  readonly identity: (manifest: M) => string;
  readonly validate: (manifest: M, events: readonly E[]) => void;
  readonly requireWritable: (manifest: M) => void;
  readonly resolvePath: (name: string) => Promise<string>;
}, expected?: M) {
  const { resolvePath } = family;
  const text = await readJsonFile(await resolvePath("campaign.json"));
  if (text === undefined && expected === undefined) throw new Error(`No campaign at ${directory}`);
  const manifest = Schema.decodeUnknownSync(family.manifest, { onExcessProperty: "error" })(text === undefined ? expected : JSON.parse(text));
  family.validate(manifest, []);
  if (expected && family.identity(manifest) !== family.identity(expected)) throw new Error("Campaign identity changed; start a new results directory");
  if (text === undefined) {
    family.requireWritable(manifest);
    await mkdir(await resolvePath("."), { recursive: true });
    await createJsonFile(await resolvePath("campaign.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const ledger = createJsonLinesLedger(() => resolvePath("events.jsonl"), family.events, "reject");
  const load = async () => {
    const events = await ledger.load();
    family.validate(manifest, events);
    return events;
  };
  await load();
  let pending = Promise.resolve();
  return {
    manifest, load,
    append(event: E): Promise<void> {
      const write = pending.then(async () => {
        family.requireWritable(manifest);
        family.validate(manifest, [...await load(), event]);
        await ledger.append(event);
      });
      pending = write.catch(() => {});
      return write;
    },
  };
}
