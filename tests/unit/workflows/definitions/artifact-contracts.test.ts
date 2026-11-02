import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  ArtifactContractSchema,
  ArtifactContractsFrontmatterSchema,
} from "../../../../src/workflows/artifact-contracts.js";

describe("artifact contract codecs", () => {
  it("normalizes transient frontmatter forms to exact canonical contracts", () => {
    for (const authored of ["review", { id: "review", lifetime: "transient" }, { id: "review", lifetime: "transient", supersedes: [] }]) {
      const decoded = Schema.decodeUnknownSync(ArtifactContractsFrontmatterSchema)([authored]);
      expect(decoded).toEqual([{ id: "review", lifetime: "transient" }]);
      expect(Schema.encodeSync(ArtifactContractsFrontmatterSchema)(decoded)).toEqual(["review"]);
    }
  });

  it("accepts canonical durable frontmatter contracts", () => {
    const writes: typeof ArtifactContractsFrontmatterSchema.Type = [{ id: "reviewed-plan", lifetime: "durable", supersedes: ["plan"] }];
    expect(Schema.decodeUnknownSync(ArtifactContractsFrontmatterSchema)(writes)).toEqual(writes);
  });

  it.each([
    { id: "x", lifetime: "unknown" },
    { id: "x", lifetime: "transient", supersedes: ["prior"] },
    { id: "x", lifetime: "durable" },
    { id: "x", lifetime: "durable", supersedes: [""] },
    { id: "x", lifetime: "durable", supersedes: ["y", "y"] },
    { id: "x", lifetime: "durable", supersedes: ["x"] },
  ])("rejects invalid frontmatter contract %#", (contract) => {
    expect(() => Schema.decodeUnknownSync(ArtifactContractsFrontmatterSchema)([contract])).toThrow();
  });

  it("keeps canonical artifact contracts strict", () => {
    expect(() => Schema.decodeUnknownSync(ArtifactContractSchema)({ id: "plan", lifetime: "durable" })).toThrow();
    expect(() => Schema.decodeUnknownSync(ArtifactContractSchema)({ id: "plan", lifetime: "transient", supersedes: [] })).toThrow();
  });
});
