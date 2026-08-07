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

export function newId(): string {
  return randomUUID()
}

/**
 * Encrypts a secret for storage. Output layout is
 * `base64(iv) . base64(authTag) . base64(ciphertext)` joined by `.` so the
 * pieces can be split without ambiguity.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, env.encryptionKey, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".")
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".")

  if (parts.length !== 3) {
    throw new Error("Malformed encrypted payload")
  }

  const [ivPart, tagPart, dataPart] = parts as [string, string, string]
  const iv = Buffer.from(ivPart, "base64")
  const authTag = Buffer.from(tagPart, "base64")
  const ciphertext = Buffer.from(dataPart, "base64")

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Malformed encrypted payload")
  }

  const decipher = createDecipheriv(ALGORITHM, env.encryptionKey, iv)
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
