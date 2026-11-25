import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { ReviewNoticeMutationSchema } from "../../../../../src/infra/substrate/events/review-notice.js";

describe("review notice mutation evidence", () => {
  it("retains a mutation file's source-truncation count", () => {
    const review: typeof ReviewNoticeMutationSchema.Type = {
      name: "large-diff",
      action: "patched",
      reach: "project",
      mutation: {
        version: 1,
        files: [{ path: "large.ts", change: "modified", unifiedDiff: "+line", omittedLines: 7 }],
        omissions: [],
      },
    };

    const decoded = Schema.decodeUnknownSync(ReviewNoticeMutationSchema, { onExcessProperty: "error" })(review);

    expect(decoded).toEqual(review);
  });
});
