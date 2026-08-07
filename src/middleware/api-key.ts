import { eq } from "drizzle-orm"
import type { Request, RequestHandler } from "express"

import type { ApiKeyScope } from "../auth/context.js"
import { db } from "../db/index.js"
import { apiKeys } from "../db/schema.js"
import { sha256 } from "../lib/crypto.js"
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js"
import { logger } from "../logger.js"

/**
 * Reads the API key from either `Authorization: Bearer <key>` or the
 * `X-API-Key` header.
 */
function extractKey(req: Request): string | null {
  const header = req.get("authorization")

  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || null
  }

  const apiKeyHeader = req.get("x-api-key")

  return apiKeyHeader?.trim() || null
}

/**
 * Authenticates a request from an integrating application.
 *
 * Keys are looked up by SHA-256 hash, so the plaintext never has to exist in
 * the database and the lookup is a single indexed equality check rather than a
 * scan with per-row comparison.
 */
export function requireApiKey(...requiredScopes: ApiKeyScope[]): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = extractKey(req)

      if (!token) {
        throw new UnauthorizedError(
          "Provide an API key via the Authorization or X-API-Key header"
        )
      }

      const [record] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, sha256(token)))
        .limit(1)

      if (!record) {
        throw new UnauthorizedError("Invalid API key")
      }

      if (record.revokedAt) {
        throw new UnauthorizedError("This API key has been revoked")
      }

      if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedError("This API key has expired")
      }

      const missing = requiredScopes.filter(
        (scope) => !record.scopes.includes(scope)
      )

      if (missing.length > 0) {
        throw new ForbiddenError(
          `This API key is missing the ${missing.join(", ")} scope`
        )
      }

      req.apiKey = {
        id: record.id,
        name: record.name,
        scopes: record.scopes,
      }

      // Usage tracking is best effort; a write failure must not reject an
      // otherwise valid ingest request.
      void db
        .update(apiKeys)
        .set({ lastUsedAt: new Date(), lastUsedIp: req.ip ?? null })
        .where(eq(apiKeys.id, record.id))
        .catch((error: unknown) => {
          logger.warn({ err: error }, "Could not record API key usage")
        })

      next()
    } catch (error) {
      next(error)
    }
  }
}

export function getApiKey(req: Request) {
  if (!req.apiKey) {
    throw new UnauthorizedError()
  }

  return req.apiKey
}
