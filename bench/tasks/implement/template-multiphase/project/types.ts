export type TemplateContext = Readonly<Record<string, unknown>>;

export type TemplateToken =
  | { kind: "text"; value: string; position: number }
  | { kind: "variable"; path: string; escaped: boolean; position: number }
  | { kind: "open"; block: "if" | "each"; path: string; position: number }
  | { kind: "close"; block: "if" | "each"; position: number };

export class TemplateError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message} at position ${position}`);
    this.name = "TemplateError";
  }
}
