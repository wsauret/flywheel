import { validateComponent } from "./descriptor-directory-contract.js";

/** Encodes one validated POSIX entry name for a libc call. */
export function componentBuffer(name: string): Buffer {
  validateComponent(name);
  return Buffer.from(`${name}\0`, "utf8");
}
