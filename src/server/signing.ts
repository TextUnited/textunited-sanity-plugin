// HMAC helpers on Web Crypto, available in Node 20+, edge runtimes, Bun and Deno.

const encoder = new TextEncoder()

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Compares two strings in time that does not depend on where they differ. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

/** Signature for a TextUnited notification URL of one document. */
export async function signDocumentId(secret: string, baseDocumentId: string): Promise<string> {
  return toHex(await hmac(secret, `textunited-events:${baseDocumentId}`))
}

export async function verifyDocumentSignature(
  secret: string,
  baseDocumentId: string,
  signature: string,
): Promise<boolean> {
  return safeEqual(await signDocumentId(secret, baseDocumentId), signature)
}

/**
 * Verifies the `sanity-webhook-signature` header of a Sanity GROQ webhook:
 * `t=<timestamp>,v1=<base64url HMAC-SHA256 of "<timestamp>.<body>">`.
 */
export async function verifySanityWebhookSignature(
  secret: string,
  header: string | null,
  body: string,
  maxAgeMs = 5 * 60 * 1000,
): Promise<boolean> {
  if (!header) return false
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const index = part.indexOf('=')
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()]
    }),
  )
  const timestamp = Number(parts.t)
  if (!parts.v1 || !Number.isFinite(timestamp)) return false
  if (Math.abs(Date.now() - timestamp) > maxAgeMs) return false
  const expected = toBase64Url(await hmac(secret, `${timestamp}.${body}`))
  return safeEqual(expected, parts.v1)
}

/** Builds a header the way Sanity does; used in tests and local tools. */
export async function createSanityWebhookSignature(
  secret: string,
  body: string,
  timestamp = Date.now(),
): Promise<string> {
  return `t=${timestamp},v1=${toBase64Url(await hmac(secret, `${timestamp}.${body}`))}`
}
