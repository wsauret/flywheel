import { describe, expect, it } from "bun:test";
import { emptyPrefixView, prefixAppend, prefixGet } from "../../../../../../src/infra/substrate/output/text/prefix-view.js";

describe("prefixGet", () => {
  it("does not see a key that was appended after the view was taken", () => {
    const older = prefixAppend(emptyPrefixView<string>(), "a", "first");
    const newer = prefixAppend(older, "b", "second");

    expect(prefixGet(older, "a")).toBe("first");
    expect(prefixGet(older, "b")).toBeUndefined();
    expect(prefixGet(newer, "a")).toBe("first");
    expect(prefixGet(newer, "b")).toBe("second");
    expect(prefixGet(newer, "missing")).toBeUndefined();
  });
});

describe("prefixAppend", () => {
  it("drops the entries past the size of an older view before it appends", () => {
    const older = prefixAppend(emptyPrefixView<string>(), "a", "first");
    prefixAppend(older, "b", "second");

    const branch = prefixAppend(older, "c", "third");

    expect(branch.size).toBe(2);
    expect(prefixGet(branch, "a")).toBe("first");
    expect(prefixGet(branch, "c")).toBe("third");
    expect(prefixGet(branch, "b")).toBeUndefined();
    expect(branch.index.ordinals.has("b")).toBe(false);
    expect(branch.index.entries.map((entry) => entry.key)).toEqual(["a", "c"]);
  });
});
