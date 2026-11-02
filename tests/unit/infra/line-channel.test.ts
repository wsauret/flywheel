/** One word per line between Flywheel processes. The listener of a launch's
 *  control channel writes its first word the moment the supervisor connects,
 *  so the connecting side must hold every word from the moment the connection
 *  opens. */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { connectLines, serveLines, type LineConnection } from "../../../src/infra/line-channel.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

function address(): string {
  return process.platform === "win32" ? String.raw`\\.\pipe\Flywheel.line-channel-test.` + `${process.pid}.${Date.now()}` : path.join(temporaryDirectory("fw-lines-"), "channel.sock");
}

describe("a line connection", () => {
  test("receives the listener's first word and ends when the listener stops", async () => {
    const at = address();
    const server = serveLines(at, (connection) => { connection.say("go"); });
    let connection: LineConnection | undefined;
    try {
      connection = await connectLines(at);

      expect(await connection?.next()).toBe("go");
      server.stop();
      expect(await Promise.race([
        connection?.ended.then(() => true),
        Bun.sleep(30).then(() => false),
      ])).toBe(true);
      expect(await connection?.next()).toBeUndefined();
    } finally {
      connection?.close();
      server.stop();
    }
  });

  test("native transport close follows a local close request", async () => {
    const at = address();
    const live = serveLines(at, (connection) => { connection.say("ready"); });
    const connection = await connectLines(at);
    try {
      expect(await connection?.next()).toBe("ready");
      connection?.close();
      await connection?.closed;
      expect(await connection?.next()).toBeUndefined();
    } finally {
      live.stop();
    }
  });

  test("answers nothing when nothing serves the address", async () => {
    expect(await connectLines(address())).toBeUndefined();
  });
});
