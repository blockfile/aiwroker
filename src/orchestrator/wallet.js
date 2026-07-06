// Minimal, dependency-free Solana address validation. A Solana address is a
// base58-encoded 32-byte public key. We decode it and require exactly 32 bytes,
// which rejects typos and junk. (This proves the string is a well-formed
// address — NOT that the runner owns it; that needs a signature.)

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export function isValidSolanaAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (addr.length < 32 || addr.length > 44) return false;

  const bytes = [];
  for (const ch of addr) {
    const val = MAP[ch];
    if (val === undefined) return false; // char outside base58 alphabet
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }

  // Each leading '1' is a leading zero byte.
  let zeros = 0;
  for (let k = 0; k < addr.length && addr[k] === '1'; k++) zeros++;

  return bytes.length + zeros === 32;
}
