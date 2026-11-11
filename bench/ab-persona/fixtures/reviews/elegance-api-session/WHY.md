# elegance-api-session: seeded defect rationale

## access-token-two-way-sync (session-store.ts, api-client.ts)

Before the change, the data flow was one way: `SessionStore` owned the session and `ApiClient.send` read `store.get()?.tokens.accessToken` when it needed the token. The change gives `ApiClient` its own `accessToken` field and makes the store push into it (`attach`, then `client?.setAccessToken(...)` in `signIn`, `replaceTokens`, and `signOut`), while the client's refresh writes new tokens back into the store (`store.replaceTokens`), which then pushes them back into the client. The token now has two homes kept equal by hand, the two classes call each other, session-store.ts imports api-client.ts, and the client registers itself from its constructor. Every new way to change the session must remember to push. The elegant shape keeps the store as the only owner: `send` reads the token from the store as before, and refresh asks the store to install the new pair. Nothing else in the change needs the copy.

It looks deliberate on a skim: the push methods are symmetric and named well, and caching a token in the HTTP client is a common habit.

## unreachable-expires-in-fallback (api-client.ts, tokens.ts)

`parseTokenPair` is the boundary parser for the token endpoint, and it throws unless `expires_in` is a finite number greater than zero. `exchangeRefreshToken` gets its pair only from `parseTokenPair`, and then still writes `pair.expiresIn > 0 ? pair.expiresIn : DEFAULT_EXPIRES_IN_SECONDS`. The false branch has no producer. It is validation repeated after a trusted boundary, and if the parser ever changed, it would hide the violation behind a made-up one-hour lifetime instead of failing loudly. The fallback and `DEFAULT_EXPIRES_IN_SECONDS` should be deleted. It looks deliberate because a default token lifetime is a common pattern in OAuth clients.

## What is intended

- `replaceTokens(from, tokens)` returning early unless the current session is still the one the refresh started from is reachable: the user can sign out, or sign out and another user sign in, while a refresh is in flight, and the comment states that the newer session wins. The same check guards the sign-out on `invalid_grant`, so an old refresh never overwrites or signs out a newer session.
- A request that was waiting for a refresh is sent with the token of the session that is current when it leaves. The client serves one signed-in user at a time, so this is the expected behavior after a sign-in, not a leak.
- Sharing one in-flight refresh through `refreshing` is a real need: concurrent requests that all see an expiring token would otherwise each spend the refresh token.
- Signing out on a 400 or 401 from the token endpoint follows OAuth (`invalid_grant`): the refresh token is dead, so the session cannot recover.
- The 401 retry happens once, so a token the server keeps rejecting cannot loop.
- The record spread in `parseTokenPair` is unchanged code at a real external boundary.
