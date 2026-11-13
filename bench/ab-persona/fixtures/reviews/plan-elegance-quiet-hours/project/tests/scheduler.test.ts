import { expect, test } from "bun:test";
import { NotificationScheduler } from "../src/notify/scheduler";
import { DEFAULT_PREFERENCES } from "../src/preferences/parse";

test("a notification during quiet hours is held until they end", async () => {
  const sent: string[] = [];
  const scheduler = new NotificationScheduler(() => DEFAULT_PREFERENCES, { send: async (n) => { sent.push(n.id); } });
  await scheduler.notify({ id: "n1", title: "Build failed" }, new Date(2026, 0, 1, 23, 0));
  expect(sent).toEqual([]);
  await scheduler.flush(new Date(2026, 0, 2, 7, 1));
  expect(sent).toEqual(["n1"]);
});
