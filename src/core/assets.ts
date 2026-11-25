import { isSupportedBlockchain, type Asset, type Blockchain, type SupportedAsset } from "../types";
import { blockchainLabel } from "../utils/blockchainLabel";

// Asset list handling shared by the form and the headless CLI, so both
// offer exactly the same tokens.

export const DFX_ASSET_LIST_URL = "https://api.dfx.swiss/v1/asset";

export type AssetMap = Partial<Record<Blockchain, SupportedAsset[]>>;

// Order assets the way the DFX backend marks them as important: sortOrder
// ascending (1..9 are the curated mainstream tokens, 99 is the bulk), name
// alphabetical for ties. The raw API order otherwise puts DFI in front of
// ETH on Ethereum, which is surprising in a tax-report context.
function sortAssetsByDfxOrder(assets: SupportedAsset[]): SupportedAsset[] {
  return [...assets].sort((a, b) => {
    const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
}

// Drop pre-launch and unsupported-chain assets, group by chain, sort.
export function groupSupportedAssets(data: Asset[]): AssetMap {
  const map: AssetMap = data
    .filter((asset) => !asset.comingSoon)
    .filter((asset): asset is SupportedAsset => isSupportedBlockchain(asset.blockchain))
    .reduce((acc: AssetMap, asset) => {
      const key = asset.blockchain as Blockchain;
      if (!acc[key]) acc[key] = [];
      acc[key]!.push(asset);
      return acc;
    }, {});
  for (const key of Object.keys(map) as Blockchain[]) {
    map[key] = sortAssetsByDfxOrder(map[key]!);
  }
  return map;
}

export async function fetchAssetMap(): Promise<AssetMap> {
  const response = await fetch(DFX_ASSET_LIST_URL);
  if (!response.ok) {
    throw new Error(`Failed to load the DFX asset list: HTTP ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("Unexpected DFX asset list response");
  return groupSupportedAssets(data as Asset[]);
}

// Pick the native coin from a per-chain asset list. The DFX API tags native
// assets with type "Coin" (ETH on Ethereum, BTC on Bitcoin, etc.) — these are
// the tokens a first-time visitor expects to see selected. We refuse to fall
// back to an arbitrary first entry: if a supported chain ever ships without a
// native coin in the asset list it's a data bug we want to surface, not paper
// over with a silently-wrong default selection.
export function pickNativeAsset(assets: SupportedAsset[]): SupportedAsset {
  const native = assets.find((a) => a.type === "Coin");
  if (!native) {
    const chain = assets[0]?.blockchain ?? "(empty list)";
    throw new Error(`No native coin found for chain ${chain}`);
  }
  return native;
}

export type AssetType = "Coin" | "Token";

// Resolve a token by its exact name on a chain, as the `?token=` URL
// parameter does. `type` narrows the match when a coin and a token would
// share a name; an unknown or still ambiguous token is an error.
export function resolveAsset(
  map: AssetMap,
  network: Blockchain,
  token: string,
  type: AssetType | undefined,
): SupportedAsset {
  const candidates = map[network];
  if (!candidates?.length) {
    throw new Error(`No assets available on ${blockchainLabel(network)}`);
  }
  const matches = candidates.filter((a) => a.name === token && (type === undefined || a.type === type));
  if (matches.length === 0) {
    const suffix = type ? ` with type ${type}` : "";
    throw new Error(`Token "${token}"${suffix} not found on ${blockchainLabel(network)}`);
  }
  if (matches.length > 1) {
    const list = matches.map((a) => `${a.name} (${a.type ?? "no type"}, id ${a.id})`).join(", ");
    throw new Error(
      `Token "${token}" is ambiguous on ${blockchainLabel(network)}: ${list} — add a token type (Coin or Token)`,
    );
  }
  return matches[0];
}
