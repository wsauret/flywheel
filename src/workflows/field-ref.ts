// A field reference: `<source>.<field>`, where the source is a phase, a
// named agent, or the launch input, and the field is a field of its output.
// `over`, `if`, `repeat.while`, and `repeat.each` name an output field this
// way. Phase and agent names have no dot, so the field is the segment after
// the only `.`. A field with a dot cannot be named.

export interface FieldRef {
  readonly source: string;
  readonly field: string;
}

export class FieldRefError extends Error {
  constructor(raw: string) {
    super(`Malformed field reference "${raw}": expected "<phase>.<field>"`);
    this.name = "FieldRefError";
  }
}

/** Parse "<source>.<field>" into its halves. Throws FieldRefError on a
 *  missing `.`, an empty half, or a dotted source. */
export function parseFieldRef(raw: string): FieldRef {
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1 || raw.includes(".", dot + 1)) throw new FieldRefError(raw);
  return { source: raw.slice(0, dot), field: raw.slice(dot + 1) };
}
