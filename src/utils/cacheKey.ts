// Single version prefix for every localStorage entry the app writes. Bump
// when an on-disk cache schema changes so we don't read entries written by
// an older code path. Keep the prefix narrow — it's a free-form namespace,
// not a semantic version. Increment to v2:, v3: etc. on the next break.
// v2: prices are cached as raw CoinGecko history per coin id and day; v1
// entries could hold current-price fallbacks or ESTV-overridden values.
export const CACHE_VERSION = "v2";

export function cacheKey(parts: ReadonlyArray<string | number>): string {
  return `${CACHE_VERSION}:${parts.join("-")}`;
}
