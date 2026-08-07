import { createHmac } from "node:crypto"

import { env } from "../env.js"
import { ServiceUnavailableError } from "../lib/errors.js"
import { logger } from "../logger.js"

/**
 * Cloudflare Images.
 *
 * Uploads never pass through this server. The client asks for a one-time
 * direct-upload URL, posts the file straight to Cloudflare, and sends us back
 * the resulting image id. Images are created with `requireSignedURLs` so a
 * leaked id is not enough to read the asset - every read goes through a
 * short-lived signed URL minted here.
 */

const API_BASE = "https://api.cloudflare.com/client/v4"

type CloudflareResponse<T> = {
  success: boolean
  errors: { code: number; message: string }[]
  result: T
}

function requireConfigured(): {
  accountId: string
  apiToken: string
  accountHash: string
} {
  if (
    !env.images.configured ||
    !env.images.accountId ||
    !env.images.apiToken ||
    !env.images.accountHash
  ) {
    throw new ServiceUnavailableError(
      "Cloudflare Images is not configured on this instance"
    )
  }

  return {
    accountId: env.images.accountId,
    apiToken: env.images.apiToken,
    accountHash: env.images.accountHash,
  }
}

export function imagesConfigured(): boolean {
  return env.images.configured
}

export type DirectUpload = {
  uploadUrl: string
  imageId: string
}

/**
 * Mints a single-use upload URL. `metadata` is stored on the Cloudflare object
 * so uploads can be traced back to the panel user that requested them.
 */
export async function createDirectUpload(params: {
  requestedByUserId: string
  purpose: "avatar" | "branding"
}): Promise<DirectUpload> {
  const { accountId, apiToken } = requireConfigured()

  const form = new FormData()
  form.append("requireSignedURLs", "true")
  form.append(
    "metadata",
    JSON.stringify({
      purpose: params.purpose,
      requestedBy: params.requestedByUserId,
      tenant: env.TENANT_SLUG,
    })
  )
  // Upload URLs are single use; a short window is plenty for a picker flow.
  form.append("expiry", new Date(Date.now() + 10 * 60_000).toISOString())

  const response = await fetch(
    `${API_BASE}/accounts/${accountId}/images/v2/direct_upload`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    }
  )

  const payload = (await response.json().catch(() => null)) as
    | CloudflareResponse<{ id: string; uploadURL: string }>
    | null

  if (!response.ok || !payload?.success) {
    logger.error(
      { status: response.status, errors: payload?.errors },
      "Cloudflare Images direct upload request failed"
    )
    throw new ServiceUnavailableError("Could not start image upload")
  }

  return {
    uploadUrl: payload.result.uploadURL,
    imageId: payload.result.id,
  }
}

/** Confirms an image id exists and was uploaded, before we persist it. */
export async function imageExists(imageId: string): Promise<boolean> {
  const { accountId, apiToken } = requireConfigured()

  const response = await fetch(
    `${API_BASE}/accounts/${accountId}/images/v1/${encodeURIComponent(imageId)}`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  )

  if (!response.ok) {
    return false
  }

  const payload = (await response.json().catch(() => null)) as
    | CloudflareResponse<{ id: string; draft?: boolean }>
    | null

  // `draft: true` means the direct upload URL was created but never used.
  return Boolean(payload?.success && payload.result?.draft !== true)
}

export async function deleteImage(imageId: string): Promise<void> {
  const { accountId, apiToken } = requireConfigured()

  const response = await fetch(
    `${API_BASE}/accounts/${accountId}/images/v1/${encodeURIComponent(imageId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    }
  )

  if (!response.ok) {
    logger.warn({ imageId, status: response.status }, "Image delete failed")
  }
}

/**
 * Builds a signed delivery URL.
 *
 * Cloudflare validates `exp` and `sig` query parameters where the signature is
 * HMAC-SHA256 over the path plus query string using the account signing key.
 */
export function signedImageUrl(
  imageId: string,
  variant = "public",
  ttlSeconds = env.images.urlTtlSeconds
): string | null {
  if (!env.images.configured || !env.images.accountHash) {
    return null
  }

  const base = `https://imagedelivery.net/${env.images.accountHash}/${imageId}/${variant}`

  if (!env.images.signingKey) {
    // Signing key absent: the variant must be public for this to resolve.
    return base
  }

  const url = new URL(base)
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds
  url.searchParams.set("exp", String(expiry))

  const stringToSign = `${url.pathname}?${url.searchParams.toString()}`
  const signature = createHmac("sha256", env.images.signingKey)
    .update(stringToSign)
    .digest("hex")

  url.searchParams.set("sig", signature)

  return url.toString()
}
