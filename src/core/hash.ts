// A small, synchronous, dependency-free hash that gives the same result in the browser
// (Studio) and on the server. It is used only to derive stable identifiers, never for
// security: two independent 64-bit FNV-1a passes give a 128-bit value, which keeps the
// chance of two paths in one document colliding negligible.

const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

function fnv1a64(input: string, offsetBasis: bigint): bigint {
  let hash = offsetBasis
  // Hash UTF-8 bytes so the result does not depend on the platform's string encoding.
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK_64
  }
  return hash
}

/** Returns a 32-character lowercase hex digest of the input. */
export function stableHash(input: string): string {
  const first = fnv1a64(input, 0xcbf29ce484222325n)
  const second = fnv1a64(input, 0x84222325cbf29ce4n)
  return first.toString(16).padStart(16, '0') + second.toString(16).padStart(16, '0')
}
