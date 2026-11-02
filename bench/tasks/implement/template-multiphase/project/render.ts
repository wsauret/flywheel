import { tokenize } from "./tokenizer.js";
import type { TemplateContext } from "./types.js";

export function render(template: string, _context: TemplateContext = {}): string {
  return tokenize(template)
    .map((token) => token.kind === "text" ? token.value : "")
    .join("");
}
