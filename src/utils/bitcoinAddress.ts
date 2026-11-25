// Bech32/bech32m mainnet addresses (hrp "bc") are case-insensitive: BIP-173
// allows all-lowercase or all-uppercase (QR codes use "BC1Q…"), never mixed.
// Esplora returns them in lowercase. Base58 addresses (legacy/P2SH) are
// case-sensitive and must never be changed.
const BECH32_MAINNET_PREFIX = /^bc1/i;

export const isBech32MainnetForm = (address: string): boolean => BECH32_MAINNET_PREFIX.test(address);

// The canonical spelling of a Bitcoin address: an all-uppercase bech32
// address becomes lowercase; everything else (lowercase bech32, mixed-case
// bech32, Base58, EVM addresses) is returned unchanged.
export function canonicalBitcoinAddress(address: string): string {
  return isBech32MainnetForm(address) && address === address.toUpperCase() ? address.toLowerCase() : address;
}
