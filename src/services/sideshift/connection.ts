import { eq, sql } from "drizzle-orm"

import { db } from "../../db/index.js"
import {
  sideshiftConnection,
  type SideshiftConnection,
} from "../../db/schema.js"
import { scopedTenantId } from "../../db/scope.js"
import { decryptSecret, encryptSecret } from "../../lib/crypto.js"
import { logger } from "../../logger.js"
import { SideshiftError } from "./client.js"
import { refreshTokens, type TokenSet } from "./oauth.js"

/** Refresh this long before the access token's stated expiry. */
const REFRESH_MARGIN_MS = 2 * 60_000

/**
 * Arbitrary int4 namespace for the two-key `pg_advisory_lock`; the second key
 * is the tenant id's hash. Every code path that can use or rotate a tenant's
 * refresh token (sync, OAuth callback, disconnect) holds that tenant's lock,
 * so two of them can never refresh at once. Sideshift treats a reused refresh
 * token as theft and revokes the whole connection. Tenants never wait on each
 * other, apart from the rare hash collision, which only costs a skipped sync.
 *
 * The lock lives in Postgres rather than in memory so it still holds while
 * Railway briefly runs the old and new container side by side during a deploy.
 */
const LOCK_NAMESPACE = 731_140_211

export async function loadConnection(
  tenantId: string
): Promise<SideshiftConnection | undefined> {
  const [row] = await db
    .select()
    .from(sideshiftConnection)
    .where(eq(sideshiftConnection.tenantId, tenantId))
    .limit(1)

  return row
}

/**
 * The connection with a pending OAuth request for this `state`. The callback
 * arrives without a session, so this is how it learns whose connection it is.
 */
export async function findConnectionByStateHash(
  stateHash: string
): Promise<SideshiftConnection | undefined> {
  const [row] = await db
    .select()
    .from(sideshiftConnection)
    .where(eq(sideshiftConnection.oauthStateHash, stateHash))
    .limit(1)

  return row
}

export async function ensureConnection(
  tenantId: string
): Promise<SideshiftConnection> {
  await db
    .insert(sideshiftConnection)
    .values({ tenantId })
    .onConflictDoNothing()

  return (await loadConnection(tenantId))!
}

export async function updateConnection(
  tenantId: string,
  values: Partial<typeof sideshiftConnection.$inferInsert>
) {
  const { tenantId: _ignored, ...rest } = values

  await db
    .update(sideshiftConnection)
    .set({ ...rest, updatedAt: new Date() })
    .where(eq(sideshiftConnection.tenantId, tenantId))
}

/**
 * Runs `fn` while holding the tenant's Sideshift lock. Returns
 * `{ acquired: false }` without running it when the lock is busy, after
 * waiting up to `waitMs`.
 */
export async function withSideshiftLock<T>(
  tenantId: string,
  fn: () => Promise<T>,
  { waitMs = 0 }: { waitMs?: number } = {}
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  // Session-level advisory locks belong to one connection, so this must run
  // on the caller's scoped connection; on the bare pool the lock and unlock
  // could land on different connections.
  if (scopedTenantId() !== tenantId) {
    throw new Error("withSideshiftLock must run inside the tenant's scope")
  }

  const deadline = Date.now() + waitMs

  for (;;) {
    const result = await db.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_lock(${LOCK_NAMESPACE}, hashtext(${tenantId})) as locked`
    )

    if (result.rows[0]?.locked) {
      break
    }

    if (Date.now() >= deadline) {
      return { acquired: false }
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  try {
    return { acquired: true, value: await fn() }
  } finally {
    // If the scope is gone (request aborted) the connection was destroyed,
    // which released the lock with it.
    await db
      .execute(
        sql`select pg_advisory_unlock(${LOCK_NAMESPACE}, hashtext(${tenantId}))`
      )
      .catch((error: unknown) => {
        logger.warn({ err: error }, "Could not release the Sideshift lock")
      })
  }
}

export function clientCredentials(row: SideshiftConnection) {
  if (!row.clientId || !row.clientSecretEncrypted) {
    throw new SideshiftError(0, "not_registered", "Sideshift is not connected")
  }

  return {
    clientId: row.clientId,
    clientSecret: decryptSecret(
      row.clientSecretEncrypted,
      sideshiftBinding(row.tenantId)
    ),
  }
}

/** Persists a fresh token pair. Called straight after Sideshift issues one. */
export async function saveTokens(tenantId: string, tokens: TokenSet) {
  await updateConnection(tenantId, {
    accessTokenEncrypted: encryptSecret(
      tokens.accessToken,
      sideshiftBinding(tenantId)
    ),
    refreshTokenEncrypted: encryptSecret(
      tokens.refreshToken,
      sideshiftBinding(tenantId)
    ),
    accessTokenExpiresAt: tokens.expiresAt,
    scope: tokens.scope,
  })
}

/**
 * A usable access token, refreshing first when it is close to expiry or when
 * `force` is set (after a 401). Must be called while holding the lock.
 */
export async function getAccessToken(
  tenantId: string,
  { force = false }: { force?: boolean } = {}
): Promise<string> {
  const row = await loadConnection(tenantId)

  if (!row?.refreshTokenEncrypted || row.status === "disconnected") {
    throw new SideshiftError(0, "not_connected", "Sideshift is not connected")
  }

  const fresh =
    row.accessTokenEncrypted &&
    row.accessTokenExpiresAt &&
    row.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS

  if (fresh && !force) {
    return decryptSecret(row.accessTokenEncrypted!, sideshiftBinding(tenantId))
  }

  const tokens = await refreshTokens(
    clientCredentials(row),
    decryptSecret(row.refreshTokenEncrypted, sideshiftBinding(tenantId))
  )

  await saveTokens(tenantId, tokens)

  return tokens.accessToken
}

/* -------------------------------------------------------------------------- */
/* Failure handling                                                            */
/* -------------------------------------------------------------------------- */

/** What the founder is told, keyed by Sideshift's error code. */
export function describeFailure(error: unknown): {
  message: string
  status?: SideshiftConnection["status"]
  requestId: string | null
} {
  if (!(error instanceof SideshiftError)) {
    return {
      message: "Sync failed unexpectedly. Cached data is still shown.",
      requestId: null,
    }
  }

  if (error.code === "invalid_grant" || error.status === 401) {
    return {
      message: "Sideshift needs to be reconnected.",
      status: "needs_reconnect",
      requestId: error.requestId,
    }
  }

  if (error.status === 402 || error.code === "subscription_required") {
    return {
      message: "Your Sideshift subscription is inactive.",
      status: "subscription_inactive",
      requestId: error.requestId,
    }
  }

  if (error.code === "insufficient_scope") {
    return {
      message:
        "Sideshift permissions changed. Reconnect Sideshift to restore access.",
      status: "needs_reconnect",
      requestId: error.requestId,
    }
  }

  if (error.status === 429 || error.code === "rate_limited") {
    return {
      message: "Sideshift is rate limiting requests. Trying again later.",
      requestId: error.requestId,
    }
  }

  if (error.status === 0 || error.status >= 500) {
    return {
      message:
        "Sideshift is having trouble right now. Showing the last synced data.",
      requestId: error.requestId,
    }
  }

  return { message: error.message, requestId: error.requestId }
}

export async function recordFailure(tenantId: string, error: unknown) {
  const failure = describeFailure(error)

  logger.warn(
    {
      err: error instanceof SideshiftError ? undefined : error,
      code: error instanceof SideshiftError ? error.code : undefined,
      requestId: failure.requestId,
      tenantId,
    },
    `Sideshift sync failed: ${failure.message}`
  )

  await updateConnection(tenantId, {
    lastError: failure.message,
    lastErrorAt: new Date(),
    lastErrorRequestId: failure.requestId,
    ...(failure.status ? { status: failure.status } : {}),
  })
}

/** What every Sideshift secret of a tenant is sealed to; see encryptSecret. */
export function sideshiftBinding(tenantId: string): string {
  return `${tenantId}:sideshift`
}
