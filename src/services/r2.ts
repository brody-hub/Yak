import { randomUUID } from "node:crypto"

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { env } from "../env.js"
import { BadRequestError, ServiceUnavailableError } from "../lib/errors.js"
import { logger } from "../logger.js"

/**
 * Cloudflare R2 (S3-compatible).
 *
 * Uploads never pass through this server. The client asks for a short-lived
 * presigned PUT URL, writes the file straight to R2, then persists the object
 * key on the user/theme row. Reads go through `/api/media/...`, which issues a
 * short-lived signed GET and redirects.
 */

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
])

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}

let client: S3Client | null = null

function requireConfigured(): {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
} {
  if (
    !env.r2.configured ||
    !env.r2.accountId ||
    !env.r2.accessKeyId ||
    !env.r2.secretAccessKey ||
    !env.r2.bucket
  ) {
    throw new ServiceUnavailableError(
      "Cloudflare R2 is not configured on this instance"
    )
  }

  return {
    accountId: env.r2.accountId,
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
    bucket: env.r2.bucket,
  }
}

function getClient(): S3Client {
  const cfg = requireConfigured()

  if (!client) {
    const jurisdiction = env.r2.jurisdiction
    const host = jurisdiction
      ? `${cfg.accountId}.${jurisdiction}.r2.cloudflarestorage.com`
      : `${cfg.accountId}.r2.cloudflarestorage.com`

    client = new S3Client({
      region: "auto",
      endpoint: `https://${host}`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    })
  }

  return client
}

export function r2Configured(): boolean {
  return env.r2.configured
}

/** Kept for older clients that still check `imagesConfigured`. */
export function imagesConfigured(): boolean {
  return r2Configured()
}

/** Maps browser/OS aliases onto the types R2 + our allowlist expect. */
export function normalizeContentType(contentType: string): string {
  const normalized = contentType.trim().toLowerCase()

  if (normalized === "image/jpg" || normalized === "image/pjpeg") {
    return "image/jpeg"
  }

  if (normalized === "image/x-png") {
    return "image/png"
  }

  return normalized
}

export function isAllowedContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(normalizeContentType(contentType))
}

export type DirectUpload = {
  uploadUrl: string
  imageId: string
  method: "PUT"
  headers: Record<string, string>
}

function objectKey(params: {
  tenantId: string
  purpose: "avatar" | "branding"
  requestedByUserId: string
  contentType: string
}): string {
  const ext = EXT_BY_TYPE[params.contentType] ?? "bin"
  return `${params.tenantId}/${params.purpose}/${params.requestedByUserId}/${randomUUID()}.${ext}`
}

/**
 * Mints a short-lived PUT URL. The returned `imageId` is the R2 object key to
 * persist after the browser finishes the upload.
 */
/** Logos and avatars; anything bigger is not an image for a panel. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export async function createDirectUpload(params: {
  tenantId: string
  requestedByUserId: string
  purpose: "avatar" | "branding"
  contentType: string
  sizeBytes: number
}): Promise<DirectUpload> {
  const { bucket } = requireConfigured()

  const contentType = normalizeContentType(params.contentType)

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new BadRequestError("Unsupported image type")
  }

  if (
    !Number.isInteger(params.sizeBytes) ||
    params.sizeBytes <= 0 ||
    params.sizeBytes > MAX_UPLOAD_BYTES
  ) {
    throw new BadRequestError("Image is too large")
  }

  const key = objectKey({
    tenantId: params.tenantId,
    purpose: params.purpose,
    requestedByUserId: params.requestedByUserId,
    contentType,
  })

  // Content type and length are part of the signature, so the URL can only
  // store an object of this type and exactly this size.
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: params.sizeBytes,
  })

  const uploadUrl = await getSignedUrl(getClient(), command, {
    expiresIn: 10 * 60,
  })

  return {
    uploadUrl,
    imageId: key,
    method: "PUT",
    headers: { "Content-Type": contentType },
  }
}

/** Confirms an object exists in the bucket before we persist the key. */
export async function imageExists(imageId: string): Promise<boolean> {
  const { bucket } = requireConfigured()

  try {
    await getClient().send(
      new HeadObjectCommand({ Bucket: bucket, Key: imageId })
    )
    return true
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? String((error as { name: unknown }).name)
        : ""
    if (name === "NotFound" || name === "NoSuchKey") {
      return false
    }

    logger.warn({ err: error, imageId }, "R2 head object failed")
    return false
  }
}

export async function deleteImage(imageId: string): Promise<void> {
  const { bucket } = requireConfigured()

  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: bucket, Key: imageId })
    )
  } catch (error) {
    logger.warn({ err: error, imageId }, "R2 delete failed")
  }
}

/**
 * Stable delivery URL served by this API. `/api/media/*` issues a short-lived
 * signed GET and redirects, so serializers can stay synchronous.
 */
export function signedImageUrl(imageId: string): string | null {
  if (!r2Configured() || !imageId) {
    return null
  }

  const path = imageId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")

  return `${env.API_URL}/api/media/${path}`
}

/** Used by the media redirect route. */
export async function createSignedReadUrl(
  imageId: string,
  ttlSeconds = env.r2.urlTtlSeconds
): Promise<string> {
  const { bucket } = requireConfigured()

  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: bucket, Key: imageId }),
    { expiresIn: ttlSeconds }
  )
}

/**
 * Keys we mint look like `tenantId/purpose/userId/uuid.ext`. Keys from before
 * multi-tenancy have the old TENANT_SLUG in the first segment and the same
 * shape otherwise. The media route serves any key of this shape: keys are
 * unguessable, and logos and avatars are shown on screens anyway.
 */
const MANAGED_KEY =
  /^[A-Za-z0-9_-]+\/(avatar|branding)\/[A-Za-z0-9_-]+\/[A-Za-z0-9.-]+$/

export function isManagedObjectKey(key: string): boolean {
  return MANAGED_KEY.test(key)
}

/**
 * Whether a key was minted for this tenant (and, for avatars, this user), so
 * nobody can point their logo or avatar at another tenant's upload.
 */
export function isTenantObjectKey(
  key: string,
  tenantId: string,
  purpose: "avatar" | "branding",
  userId?: string
): boolean {
  const prefix = userId
    ? `${tenantId}/${purpose}/${userId}/`
    : `${tenantId}/${purpose}/`

  return isManagedObjectKey(key) && key.startsWith(prefix)
}
