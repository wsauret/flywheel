import { describe, expect, it } from "bun:test";
import { clearLibcErrno, libcError } from "../../../src/infra/libc.js";

// The thread errno slot is a POSIX binding: NO_LIBC_REASON in src/infra/libc.ts
// states that Windows has none.
describe.skipIf(process.platform === "win32")("libcError", () => {
  it("names an errno that has no symbolic code by its number", () => {
    // errno 0 has no name on any platform, as do several darwin codes such as
    // ENOATTR. Without the number the failure is not diagnosable.
    clearLibcErrno();
    const failure = libcError("openat");

    expect(failure.message).toBe("openat failed with errno 0");
    expect(failure).toMatchObject({ code: "UNKNOWN", errno: 0, operation: "openat" });
  });
});
