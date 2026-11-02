import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";

import { encryptWebPushPayload, fromBase64Url, importEncryptionMaterial, sendWebPush, toBase64Url, vapidAuthorization, type PushPost } from "../../../src/infra/web-push.js";

/** RFC 8291 Appendix A is the one published end-to-end example. Reproducing its
 *  ciphertext byte for byte proves the key agreement, the two HKDF steps, the
 *  record header, and the delimiter, all at once. */
const RFC_8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  subscription: {
    endpoint: "https://push.example.net/send/x",
    keys: {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
  },
  server: {
    privateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    publicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
  },
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function vapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("expected a pair");
  return {
    keys: { publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), privateKey: Redacted.make(toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)))) },
    verify: pair.publicKey,
  };
}

describe("web push encryption", () => {
  test("reproduces the RFC 8291 Appendix A ciphertext", async () => {
    const material = await importEncryptionMaterial(RFC_8291.server);
    const body = await encryptWebPushPayload(RFC_8291.subscription, new TextEncoder().encode(RFC_8291.plaintext), material);
    expect(toBase64Url(body)).toBe(RFC_8291.body);
  });

  test("refuses a payload the push service would refuse", async () => {
    const material = await importEncryptionMaterial(RFC_8291.server);
    await expect(encryptWebPushPayload(RFC_8291.subscription, new Uint8Array(4096), material)).rejects.toThrow(/at most/);
  });
});

describe("VAPID authorization", () => {
  test("signs a JWT for the push service origin that verifies under the public key", async () => {
    const { keys, verify } = await vapidKeys();
    const header = await vapidAuthorization(keys, "https://push.example.net/send/abc?x=1", "https://flywl.sh", 1_700_000_000_000);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, token, publicKey] = match!;
    expect(publicKey).toBe(keys.publicKey);
    const [encodedHeader, encodedClaims, encodedSignature] = token!.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(encodedHeader!)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedClaims!)));
    expect(claims.aud).toBe("https://push.example.net");
    expect(claims.sub).toBe("https://flywl.sh");
    expect(claims.exp).toBe(1_700_000_000 + 12 * 3600);
    const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verify, fromBase64Url(encodedSignature!), new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
    expect(verified).toBe(true);
  });
});

describe("sending", () => {
  test("refuses pre-aborted delivery and carries cancellation through the HTTP boundary", async () => {
    const { keys } = await vapidKeys();
    const controller = new AbortController();
    const reason = new Error("delivery retired");
    const message = { title: "Turn finished", body: "Done", url: "https://remote.example.test" };
    let posts = 0;
    const post: PushPost = async (_url, init) => {
      posts++;
      expect(init.signal).toBe(controller.signal);
      controller.abort(reason);
      return new Response("", { status: 201 });
    };
    const input = { subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post, signal: controller.signal };
    await expect(sendWebPush(input)).rejects.toBe(reason);
    expect(posts).toBe(1);
    await expect(sendWebPush(input)).rejects.toBe(reason);
    expect(posts).toBe(1);
  });

  test("posts an aes128gcm body with the VAPID header and classifies the answer", async () => {
    const { keys } = await vapidKeys();
    const requests: Array<{ url: string; headers: Headers; bytes: number }> = [];
    const respond = (status: number): PushPost => async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers), bytes: init.body.byteLength });
      return new Response(status === 410 ? "gone" : "", { status });
    };
    const message = { title: "Turn finished", body: "Reply with exactly the word PHONE", url: "https://remote.flywl.sh/#session=abc" };
    expect(await sendWebPush({ subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post: respond(201) })).toEqual({ kind: "delivered", status: 201 });
    expect(await sendWebPush({ subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post: respond(410) })).toEqual({ kind: "gone", status: 410 });
    expect((await sendWebPush({ subscription: RFC_8291.subscription, vapid: keys, subject: "https://flywl.sh", message, post: respond(500) })).kind).toBe("failed");
    expect(requests[0]!.url).toBe(RFC_8291.subscription.endpoint);
    expect(requests[0]!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(requests[0]!.headers.get("authorization")).toMatch(/^vapid t=/);
    expect(requests[0]!.bytes).toBeGreaterThan(86);
  });
});
