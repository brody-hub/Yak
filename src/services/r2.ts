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

export function isAllowedContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType)
}

export type DirectUpload = {
  uploadUrl: string
  imageId: string
  method: "PUT"
  headers: { "Content-Type": string }
}

function objectKey(params: {
  purpose: "avatar" | "branding"
  requestedByUserId: string
  contentType: string
}): string {
  const ext = EXT_BY_TYPE[params.contentType] ?? "bin"
  return `${env.TENANT_SLUG}/${params.purpose}/${params.requestedByUserId}/${randomUUID()}.${ext}`
}

/**
 * Mints a short-lived PUT URL. The returned `imageId` is the R2 object key to
 * persist after the browser finishes the upload.
 */
export async function createDirectUpload(params: {
  requestedByUserId: string
  purpose: "avatar" | "branding"
  contentType: string
}): Promise<DirectUpload> {
  const { bucket } = requireConfigured()

  if (!isAllowedContentType(params.contentType)) {
    throw new BadRequestError("Unsupported image type")
  }

  const key = objectKey(params)
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: params.contentType,
  })

  const uploadUrl = await getSignedUrl(getClient(), command, {
    expiresIn: 10 * 60,
  })

  return {
    uploadUrl,
    imageId: key,
    method: "PUT",
    headers: { "Content-Type": params.contentType },
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

/** Keys we mint look like `tenant/purpose/userId/uuid.ext`. */
export function isManagedObjectKey(key: string): boolean {
  return new RegExp(
    `^${escapeRegex(env.TENANT_SLUG)}/(avatar|branding)/[A-Za-z0-9_-]+/[A-Za-z0-9.-]+$`
  ).test(key)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
