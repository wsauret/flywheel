import { readFile } from "node:fs/promises";

/** Decoding of the JSON files that the analysis reads: run artifacts, board
 *  data, and its own records. Each decoder checks the shape it returns, so
 *  no caller asserts a type. */

export interface JsonMap { readonly [key: string]: unknown }

export function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as an object, or a thrown error that names `what`. */
export function jsonMap(value: unknown, what: string): JsonMap {
  if (!isJsonMap(value)) throw new Error(`${what} is not an object`);
  return value;
}

export function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} is not a string`);
  return value;
}

export function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw new Error(`${what} is not a list of strings`);
  return value;
}

/** An object whose every value is a string. */
export function stringMap(value: unknown, what: string): { readonly [key: string]: string } {
  return Object.fromEntries(Object.entries(jsonMap(value, what)).map(([key, item]) => [key, text(item, `${what}.${key}`)]));
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether a file system error says that the path does not exist. */
export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** The parsed file, or undefined when it does not exist. */
export async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return await readJsonFile(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}
