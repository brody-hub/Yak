import { eq } from "drizzle-orm"
import type { Request, RequestHandler } from "express"

import type { ApiKeyScope } from "../auth/context.js"
import { apiKeys, apps, tenants } from "../db/schema.js"
import {
  enterRequestScope,
  withLookupScope,
  withTenantScope,
} from "../db/scope.js"
import { sha256 } from "../lib/crypto.js"
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js"
import { logger } from "../logger.js"
import { recordApiKeyFailure } from "../services/api-key-usage.js"

/** `last_used_at` is written at most this often per key. */
const USAGE_WRITE_INTERVAL_MS = 60_000

const lastUsageWrite = new Map<string, number>()

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
 * Best effort and throttled, so a busy integration does not turn every
 * request into a write. Runs in its own scope because the request's may be
 * released by the time it runs.
 */
function recordUsage(
  key: { id: string; tenantId: string },
  ip: string | undefined
) {
  const now = Date.now()
  const last = lastUsageWrite.get(key.id) ?? 0

  if (now - last < USAGE_WRITE_INTERVAL_MS) {
    return
  }

  lastUsageWrite.set(key.id, now)

  void withTenantScope(key.tenantId, (scoped) =>
    scoped
      .update(apiKeys)
      .set({ lastUsedAt: new Date(now), lastUsedIp: ip ?? null })
      .where(eq(apiKeys.id, key.id))
  ).catch((error: unknown) => {
    logger.warn({ err: error }, "Could not record API key usage")
  })
}

/**
 * Authenticates a request from an integrating application and binds the rest
 * of it to the key's tenant.
 *
 * Keys are looked up by SHA-256 hash, so the plaintext never has to exist in
 * the database and the lookup is a single indexed equality check rather than a
 * scan with per-row comparison. The lookup, with the owning tenant's and app's
 * status, runs in the read-only lookup scope because the tenant is not known
 * until the key is found; everything after it runs in that tenant's scope.
 */
export function requireApiKey(
  ...requiredScopes: ApiKeyScope[]
): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = extractKey(req)

      if (!token) {
        throw new UnauthorizedError(
          "Provide an API key via the Authorization or X-API-Key header"
        )
      }

      const found = await withLookupScope(async (lookup) => {
        const [row] = await lookup
          .select({
            key: apiKeys,
            tenantStatus: tenants.status,
            appStatus: apps.status,
          })
          .from(apiKeys)
          .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
          .innerJoin(apps, eq(apps.id, apiKeys.appId))
          .where(eq(apiKeys.keyHash, sha256(token)))
          .limit(1)

        return row
      })

      if (!found) {
        throw new UnauthorizedError("Invalid API key")
      }

      const record = found.key

      // A suspended account stops accepting data until it is reactivated.
      if (found.tenantStatus !== "active") {
        recordApiKeyFailure(record, req, {
          status: 403,
          code: "forbidden",
          detail: "This account has been suspended",
        })
        throw new ForbiddenError("This account has been suspended")
      }

      if (found.appStatus !== "active") {
        recordApiKeyFailure(record, req, {
          status: 403,
          code: "forbidden",
          detail: "This app has been archived",
        })
        throw new ForbiddenError("This app has been archived")
      }

      if (record.revokedAt) {
        throw new UnauthorizedError("This API key has been revoked")
      }

      if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
        recordApiKeyFailure(record, req, {
          status: 401,
          code: "unauthorized",
          detail: "This API key has expired",
        })
        throw new UnauthorizedError("This API key has expired")
      }

      const missing = requiredScopes.filter(
        (scope) => !record.scopes.includes(scope)
      )

      if (missing.length > 0) {
        const detail = `This API key is missing the ${missing.join(", ")} scope`

        recordApiKeyFailure(record, req, {
          status: 403,
          code: "forbidden",
          detail,
        })
        throw new ForbiddenError(detail)
      }

      req.apiKey = {
        id: record.id,
        tenantId: record.tenantId,
        appId: record.appId,
        name: record.name,
        scopes: record.scopes,
      }

      recordUsage(record, req.ip)

      await enterRequestScope(
        req,
        res,
        { kind: "tenant", tenantId: record.tenantId },
        next
      )
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
