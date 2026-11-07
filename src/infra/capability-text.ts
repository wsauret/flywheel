/**
 * Capability-conditioned prompt text (ARCH-CONTEXT-033).
 *
 * A `CapabilityCheck` answers whether one capability term holds for the agent
 * that reads a text. A term is a logical tool identity (`bash`, `subagent`),
 * `skill:<id>`, or `persona:<name>`. Kernel tools are never terms.
 *
 * Bundled Flywheel text marks a capability-specific passage with whole-line
 * markers, `{{if:a|b}}`, an optional `{{else}}`, and `{{end}}`. `|` means any
 * listed term holds. Markers do not nest.
 */

/** Whether one capability term holds. Pure: the same term gives the same answer for the life of the check. */
export type CapabilityCheck = (term: string) => boolean;

const IF_MARKER = /^\{\{if:([^}]*)\}\}$/;
const ELSE_MARKER = "{{else}}";
const END_MARKER = "{{end}}";

/**
 * Render `text` for `has`: each `{{if:...}}` block keeps the lines of its first
 * branch when any listed term holds, else the lines of its `{{else}}` branch or
 * nothing. Marker lines never reach the output; every other line is kept byte
 * for byte, so a text with no markers renders unchanged.
 *
 * Throws an Error that names the line number for a nested `{{if:}}`, an empty
 * term, an `{{else}}` or `{{end}}` outside a block, a second `{{else}}`, or a
 * block that the text does not close.
 */
export function renderCapabilityText(text: string, has: CapabilityCheck): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let block: { readonly line: number; readonly holds: boolean; inElse: boolean } | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = line.trim();
    const lineNumber = index + 1;
    const opened = IF_MARKER.exec(marker);
    if (opened) {
      if (block) throw new Error(`Capability marker at line ${lineNumber} opens a block inside the block opened at line ${block.line}; markers do not nest`);
      const terms = (opened[1] ?? "").split("|").map((term) => term.trim());
      if (terms.some((term) => term.length === 0)) throw new Error(`Capability marker at line ${lineNumber} names an empty term`);
      block = { line: lineNumber, holds: terms.some((term) => has(term)), inElse: false };
    } else if (marker === ELSE_MARKER) {
      if (!block) throw new Error(`Capability marker {{else}} at line ${lineNumber} is outside a block`);
      if (block.inElse) throw new Error(`Capability marker {{else}} at line ${lineNumber} repeats the else of the block opened at line ${block.line}`);
      block.inElse = true;
    } else if (marker === END_MARKER) {
      if (!block) throw new Error(`Capability marker {{end}} at line ${lineNumber} is outside a block`);
      block = undefined;
    } else if (!block || block.holds !== block.inElse) {
      kept.push(line);
    }
  }
  if (block) throw new Error(`Capability block opened at line ${block.line} has no {{end}}`);
  return kept.join("\n");
}
