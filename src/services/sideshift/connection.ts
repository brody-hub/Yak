import { eq } from "drizzle-orm"

import { db, pool } from "../../db/index.js"
import { sideshiftConnection, type SideshiftConnection } from "../../db/schema.js"
import { decryptSecret, encryptSecret } from "../../lib/crypto.js"
import { logger } from "../../logger.js"
import { SideshiftError } from "./client.js"
import { refreshTokens, type TokenSet } from "./oauth.js"

const ROW_ID = "default"

/** Refresh this long before the access token's stated expiry. */
const REFRESH_MARGIN_MS = 2 * 60_000

/**
 * Arbitrary constant for `pg_advisory_lock`. Every code path that can use or
 * rotate the refresh token (sync, OAuth callback, disconnect) holds this lock,
 * so two of them can never refresh at once. Sideshift treats a reused refresh
 * token as theft and revokes the whole connection.
 *
 * The lock lives in Postgres rather than in memory so it still holds while
 * Railway briefly runs the old and new container side by side during a deploy.
 */
const LOCK_KEY = 7_311_402_119

export async function loadConnection(): Promise<SideshiftConnection | undefined> {
  const [row] = await db
    .select()
    .from(sideshiftConnection)
    .where(eq(sideshiftConnection.id, ROW_ID))
    .limit(1)

  return row
}

export async function ensureConnection(): Promise<SideshiftConnection> {
  await db
    .insert(sideshiftConnection)
    .values({ id: ROW_ID })
    .onConflictDoNothing()

  return (await loadConnection())!
}

export async function updateConnection(
  values: Partial<typeof sideshiftConnection.$inferInsert>
) {
  await db
    .update(sideshiftConnection)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(sideshiftConnection.id, ROW_ID))
}

/**
 * Runs `fn` while holding the Sideshift lock. Returns `{ acquired: false }`
 * without running it when the lock is busy, after waiting up to `waitMs`.
 */
export async function withSideshiftLock<T>(
  fn: () => Promise<T>,
  { waitMs = 0 }: { waitMs?: number } = {}
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect()
  const deadline = Date.now() + waitMs

  try {
    for (;;) {
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1) as locked",
        [LOCK_KEY]
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
      await client
        .query("select pg_advisory_unlock($1)", [LOCK_KEY])
        .catch((error: unknown) => {
          logger.warn({ err: error }, "Could not release the Sideshift lock")
        })
    }
  } finally {
    client.release()
  }
}

export function clientCredentials(row: SideshiftConnection) {
  if (!row.clientId || !row.clientSecretEncrypted) {
    throw new SideshiftError(0, "not_registered", "Sideshift is not connected")
  }

  return {
    clientId: row.clientId,
    clientSecret: decryptSecret(row.clientSecretEncrypted),
  }
}

/** Persists a fresh token pair. Called straight after Sideshift issues one. */
export async function saveTokens(tokens: TokenSet) {
  await updateConnection({
    accessTokenEncrypted: encryptSecret(tokens.accessToken),
    refreshTokenEncrypted: encryptSecret(tokens.refreshToken),
    accessTokenExpiresAt: tokens.expiresAt,
    scope: tokens.scope,
  })
}

/**
 * A usable access token, refreshing first when it is close to expiry or when
 * `force` is set (after a 401). Must be called while holding the lock.
 */
export async function getAccessToken({
  force = false,
}: { force?: boolean } = {}): Promise<string> {
  const row = await loadConnection()

  if (!row?.refreshTokenEncrypted || row.status === "disconnected") {
    throw new SideshiftError(0, "not_connected", "Sideshift is not connected")
  }

  const fresh =
    row.accessTokenEncrypted &&
    row.accessTokenExpiresAt &&
    row.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS

  if (fresh && !force) {
    return decryptSecret(row.accessTokenEncrypted!)
  }

  const tokens = await refreshTokens(
    clientCredentials(row),
    decryptSecret(row.refreshTokenEncrypted)
  )

  await saveTokens(tokens)

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
      message: "Sideshift is having trouble right now. Showing the last synced data.",
      requestId: error.requestId,
    }
  }

  return { message: error.message, requestId: error.requestId }
}

export async function recordFailure(error: unknown) {
  const failure = describeFailure(error)

  logger.warn(
    {
      err: error instanceof SideshiftError ? undefined : error,
      code: error instanceof SideshiftError ? error.code : undefined,
      requestId: failure.requestId,
    },
    `Sideshift sync failed: ${failure.message}`
  )

  await updateConnection({
    lastError: failure.message,
    lastErrorAt: new Date(),
    lastErrorRequestId: failure.requestId,
    ...(failure.status ? { status: failure.status } : {}),
  })
}
