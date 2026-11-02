import type { TemplateToken } from "./types.js";

export function tokenize(template: string): TemplateToken[] {
  return template.length === 0
    ? []
    : [{ kind: "text", value: template, position: 0 }];
}
