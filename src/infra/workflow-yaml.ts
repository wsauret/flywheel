import * as yaml from "js-yaml";

/** The largest workflow file a launch reads. It also bounds the expanded
 *  size of a parsed document, which counts each value once and each
 *  character of a string or key. A file without aliases stays within it up
 *  to the few characters that writing a number out in full can add. */
export const WORKFLOW_FILE_MAX_BYTES = 256 * 1024;

const MERGE_KEY = "<<";

/** What one element of a sequence adds to a mapping key that js-yaml makes
 *  from the sequence: a string adds its characters and a comma, and any
 *  other value adds at most `[object Object],`. */
const SEQUENCE_KEY_ELEMENT_MAX = "[object Object],".length;

const expandedSizeError = (): UnsupportedWorkflowYamlError => new UnsupportedWorkflowYamlError(`The file expands to more than ${WORKFLOW_FILE_MAX_BYTES} bytes of content through YAML aliases (&anchor and *alias); write the repeated part out or remove the aliases.`);

/** A workflow document that parses as YAML but uses a YAML feature that a
 *  workflow file refuses. Its message names the feature and the fix. */
export class UnsupportedWorkflowYamlError extends Error {}

/** Parse the YAML of a workflow document, which a model or a person wrote,
 *  so that every later walk over it sees a bounded tree. The core schema
 *  keeps dates as strings and has no merge type: js-yaml expands each `<<`
 *  merge inside the parse, and repeated merges of a large anchor cost
 *  minutes there. A `<<` key, an alias tree whose expanded size passes
 *  {@link WORKFLOW_FILE_MAX_BYTES}, and a cyclic alias each throw an error
 *  that names the YAML feature and its fix. An ordinary anchor and alias
 *  still parse: a shared value counts at each place it occurs. js-yaml joins
 *  a sequence used as a mapping key into one string while it parses, so the
 *  parse charges each sequence it closes, alias or not, before that join. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: authored YAML has no trusted shape until the workflow schema decodes it.
export function parseWorkflowYaml(content: string): unknown {
  let sequences = 0;
  const document: unknown = yaml.load(content, {
    schema: yaml.CORE_SCHEMA,
    listener(event, state) {
      const result: unknown = state.result;
      if (event !== "close" || !Array.isArray(result)) return;
      for (const element of result) sequences += typeof element === "string" ? element.length + 1 : SEQUENCE_KEY_ELEMENT_MAX;
      if (sequences > WORKFLOW_FILE_MAX_BYTES) throw expandedSizeError();
    },
  });
  const ancestors = new Set<object>();
  const stack: ({ value: unknown; exit: false } | { value: object; exit: true })[] = [{ value: document, exit: false }];
  let size = 0;
  const charge = (units: number): void => {
    size += units;
    if (size > WORKFLOW_FILE_MAX_BYTES) throw expandedSizeError();
  };
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.exit) {
      ancestors.delete(frame.value);
      continue;
    }
    charge(typeof frame.value === "string" ? 1 + frame.value.length : 1);
    if (typeof frame.value !== "object" || frame.value === null) continue;
    if (ancestors.has(frame.value)) {
      throw new UnsupportedWorkflowYamlError("The file contains cyclic YAML aliases (&anchor and *alias); remove the reference to its own anchor.");
    }
    if (!Array.isArray(frame.value) && Object.hasOwn(frame.value, MERGE_KEY)) {
      throw new UnsupportedWorkflowYamlError(`The file uses a YAML merge key (${MERGE_KEY}), which a workflow file does not support; write the merged keys out.`);
    }
    ancestors.add(frame.value);
    stack.push({ value: frame.value, exit: true });
    for (const [key, value] of Object.entries(frame.value)) {
      if (!Array.isArray(frame.value)) charge(key.length);
      stack.push({ value, exit: false });
    }
  }
  return document;
}
