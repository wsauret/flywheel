# cache-pagination: seeded defect rationale

## cache-key-missing-dimension (api.ts)

pageCacheKey encodes viewerId, sort, filter, offset, and pageSize but drops `query.includeArchived`, which source.fetch uses to decide whether archived documents appear. An admin listing with includeArchived: true warms the cache, and a subsequent normal request for the same viewer/sort/filter/offset hits that entry and receives archived rows (or vice versa, silently hiding them). The key looks complete on a skim because it carries five of the six request dimensions.

## page-boundary-off-by-one (api.ts)

list() fetches exactly `pageSize` rows and infers `hasMore = items.length >= pageSize`. When the viewer has exactly N * pageSize matching documents, the last real page is full, so hasMore is true and a nextCursor is issued; following it fetches an empty page. Clients that render "load more" buttons or loop until hasMore is false observe a phantom empty page at every exact multiple.

## stale-tier-invalidation-gap (cache.ts, api.ts)

get() migrates entries older than TTL from the `fresh` map into the `stale` map, where the SWR branch serves them for up to STALE_GRACE_SECONDS. invalidatePrefix, which onPermissionsChanged relies on to purge everything a viewer can see, iterates only `fresh` and `empty`. Any page that already aged into the stale tier survives the permission revocation and continues to be served by the `cached.kind === "stale"` branch, leaking documents the viewer's access was just revoked for.

## cursor-shared-mutation (cursor.ts, api.ts)

issueCursor stores the PageState object by reference and resolveCursor returns that same reference. list() then executes `state.offset += items.length` on the resolved object and re-stores it under a new token, so the old token's map entry, being the same object, now carries the advanced offset. Replaying a previously issued cursor (client retry after a dropped response, or a back button) returns a later page than the one the cursor was issued for, and repeated replays keep drifting forward.

## negative-ttl-unit-mix (cache.ts)

isKnownEmpty divides the entry age by 1000 to get seconds, then compares against `NEGATIVE_TTL_SECONDS * 1000`. Both sides being scaled makes the guard read plausibly, but the comparison is seconds < milliseconds-count: the intended 5-second negative TTL becomes 5000 seconds (~83 minutes). A viewer whose first query ran before their documents were created keeps receiving an empty listing for over an hour. The positive-TTL checks in get() scale correctly; only this branch mixes units.
