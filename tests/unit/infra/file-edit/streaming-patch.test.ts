import { describe, expect, it, spyOn } from "bun:test";

import { FileEditPlanError } from "../../../../src/infra/file-edit/contract.js";
import { PatchOperationParser } from "../../../../src/infra/file-edit/patch-parser.js";
import { StreamingPatch } from "../../../../src/infra/file-edit/streaming-patch.js";

describe("streaming patch", () => {
  it("does not invent a final line or patch terminator", () => {
    const stream = new StreamingPatch();
    stream.append("*** Begin Patch\n*** Add File: a.txt\n+one\n");
    expect(() => stream.finish()).toThrow(new FileEditPlanError("invalid patch: The last line of the patch must be '*** End Patch'"));
  });

  it("feeds each sealed line once during preview and stops at the first end marker", () => {
    const append = spyOn(PatchOperationParser.prototype, "append");
    const stream = new StreamingPatch();
    const patch = "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n*** Delete File: b\n*** End Patch";
    for (let index = 0; index < patch.length; index += 3) stream.append(patch.slice(index, index + 3));

    expect(append).toHaveBeenCalledTimes(3);
    expect(stream.finish().operations).toEqual([{ kind: "add", path: "a", contents: "x\n" }]);
    append.mockRestore();
  });

  it("rejects any completed invalid opening line without waiting for the envelope", () => {
    for (const prefix of ["", "<<'EOF'\n"]) {
      const stream = new StreamingPatch();
      stream.append(`${prefix}not a patch`);
      expect(() => stream.append("\n")).toThrow("invalid patch: The first line of the patch must be '*** Begin Patch'");
    }
  });
});
