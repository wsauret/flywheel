import { expect, test } from "bun:test";
import { fanOut } from "../src/webhooks/fanout";

test("one failing endpoint does not stop the others", async () => {
  const fetcher = (async (url: string | URL | Request) => new Response(null, { status: String(url).includes("bad") ? 500 : 200 })) as typeof fetch;
  const outcomes = await fanOut([{ url: "https://a.example/hook", secret: "s" }, { url: "https://bad.example/hook", secret: "s" }], { id: "e1", type: "order.paid", payload: {} }, fetcher);
  expect(outcomes).toEqual([{ url: "https://a.example/hook", ok: true }, { url: "https://bad.example/hook", ok: false }]);
});
