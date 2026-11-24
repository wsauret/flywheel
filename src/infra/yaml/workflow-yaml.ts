import * as yaml from "js-yaml";
import { loadYaml, type LoadedYaml } from "./yaml-load.js";

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

/** The js-yaml 4 mapping, which joins a sequence used as a mapping key into
 *  one string key, charged for each key that it joins before the join. The
 *  mapping joins a key once to find a duplicate and again to add it, so
 *  each join is charged. */
function chargedLegacyMapTag(): typeof yaml.legacyMapTag {
  let joined = 0;
  const charge = (key: unknown): void => {
    if (!Array.isArray(key)) return;
    for (const element of key) joined += typeof element === "string" ? element.length + 1 : SEQUENCE_KEY_ELEMENT_MAX;
    if (joined > WORKFLOW_FILE_MAX_BYTES) throw expandedSizeError();
  };
  return {
    ...yaml.legacyMapTag,
    has: (carrier, key) => {
      charge(key);
      return yaml.legacyMapTag.has(carrier, key);
    },
    addPair: (carrier, key, value) => {
      charge(key);
      return yaml.legacyMapTag.addPair(carrier, key, value);
    },
  };
}

/** Parse the YAML of a workflow document, which a model or a person wrote,
 *  so that every later walk over it sees a bounded tree, and name each line
 *  whose indentation the parse raised (refer to {@link loadYaml}). The core
 *  schema keeps dates as strings and has no merge type: js-yaml expands each
 *  `<<` merge inside the parse, and repeated merges of a large anchor cost
 *  minutes there. Its mapping is the js-yaml 4 one, so a file that loaded
 *  before still loads. A `<<` key, an alias tree whose expanded size passes
 *  {@link WORKFLOW_FILE_MAX_BYTES}, and a cyclic alias each throw an error
 *  that names the YAML feature and its fix. An ordinary anchor and alias
 *  still parse: a shared value counts at each place it occurs. */
export function parseWorkflowYaml(content: string): LoadedYaml {
  const loaded = loadYaml(content, { schema: yaml.CORE_SCHEMA.withTags(chargedLegacyMapTag()) });
  const ancestors = new Set<object>();
  const stack: ({ value: unknown; exit: false } | { value: object; exit: true })[] = [{ value: loaded.document, exit: false }];
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
  return loaded;
}
