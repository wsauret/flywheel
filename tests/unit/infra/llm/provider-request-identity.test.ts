import { describe, expect, spyOn, test } from "bun:test";
import os from "node:os";
import { readAppVersion } from "../../../../src/infra/app-version.js";
import {
  openCodeGoRequestHeaders,
  openRouterRequestHeaders,
  providerRequestHeaders,
} from "../../../../src/infra/llm/provider-request-identity.js";

describe("provider request identity", () => {
  test("Every provider request carries the Flywheel user agent with the build version", async () => {
    const platform = spyOn(os, "platform").mockReturnValue("linux");
    const release = spyOn(os, "release").mockReturnValue("6.8.0");
    const arch = spyOn(os, "arch").mockReturnValue("x64");
    try {
      expect((await providerRequestHeaders())["User-Agent"]).toBe(`flywheel/${await readAppVersion()} (linux 6.8.0; x64)`);
    } finally {
      platform.mockRestore();
      release.mockRestore();
      arch.mockRestore();
    }
  });

  test("adds OpenRouter application attribution", async () => {
    expect(await openRouterRequestHeaders()).toMatchObject({
      "HTTP-Referer": "https://github.com/wsauret/flywheel",
      "X-Title": "Flywheel",
    });
  });

  test("rejects an OpenCode Go request without a stable session identity", async () => {
    expect(openCodeGoRequestHeaders(undefined)).rejects.toThrow("OpenCode Go requests require a provider session key");
  });
});
