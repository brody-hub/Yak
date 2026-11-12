import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"

import { env } from "../env.js"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
/** Payloads carrying this prefix were sealed with a binding (see below). */
const BOUND_VERSION = "v2"

export function newId(): string {
  return randomUUID()
}

/**
 * The row a secret belongs to, e.g. `${tenantId}:${appId}:revenuecat`. It is
 * authenticated along with the ciphertext, so a ciphertext copied into
 * another tenant's row (by a bug, a bad migration, or someone with database
 * access) fails to decrypt there instead of quietly working.
 */
export type SecretBinding = string

/**
 * Encrypts a secret for storage. Output layout is
 * `v2 . base64(iv) . base64(authTag) . base64(ciphertext)` joined by `.` so
 * the pieces can be split without ambiguity.
 */
export function encryptSecret(
  plaintext: string,
  binding: SecretBinding
): string {
  if (!binding) {
    throw new Error("A secret needs the binding of the row it is stored in")
  }

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, env.encryptionKey, iv)
  cipher.setAAD(Buffer.from(binding, "utf8"))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return [
    BOUND_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".")
}

/**
 * Decrypts a stored secret. Payloads written before bindings existed have
 * three parts and no binding; they still decrypt, and are re-sealed with a
 * binding the next time their row is written.
 */
export function decryptSecret(payload: string, binding: SecretBinding): string {
  const parts = payload.split(".")
  const bound = parts.length === 4 && parts[0] === BOUND_VERSION

  if (!bound && parts.length !== 3) {
    throw new Error("Malformed encrypted payload")
  }

  const [ivPart, tagPart, dataPart] = (bound ? parts.slice(1) : parts) as [
    string,
    string,
    string,
  ]
  const iv = Buffer.from(ivPart, "base64")
  const authTag = Buffer.from(tagPart, "base64")
  const ciphertext = Buffer.from(dataPart, "base64")

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Malformed encrypted payload")
  }

  const decipher = createDecipheriv(ALGORITHM, env.encryptionKey, iv)

  if (bound) {
    if (!binding) {
      throw new Error("A bound secret needs its binding to decrypt")
    }
    decipher.setAAD(Buffer.from(binding, "utf8"))
  }

  decipher.setAuthTag(authTag)

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8")
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Constant time string comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)

  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so timing does not reveal length equality.
    timingSafeEqual(bufferA, bufferA)
    return false
  }

  return timingSafeEqual(bufferA, bufferB)
}

export type GeneratedApiKey = {
  /** Full secret, shown to the operator exactly once. */
  token: string
  /** Display prefix persisted alongside the hash. */
  prefix: string
  /** SHA-256 of the token. */
  hash: string
}

/**
 * API keys look like `yak_live_<43 chars of base64url>`. Only the SHA-256 hash
 * is persisted, so a database leak cannot be replayed against the ingest API.
 */
export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(32).toString("base64url")
  const token = `yak_live_${secret}`

  return {
    token,
    prefix: token.slice(0, 15),
    hash: sha256(token),
  }
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`
}

export function generatePublicToken(): string {
  return randomBytes(18).toString("base64url")
}

/**
 * Temporary password for invited users. Deliberately long and random; the
 * recipient is forced to replace it on first sign in.
 */
export function generateTemporaryPassword(): string {
  return `${randomBytes(12).toString("base64url")}Aa1!`
}

export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex")
}
