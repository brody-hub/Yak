import { Pool } from "pg"

import { env } from "../env.js"
import { logger } from "../logger.js"

/**
 * The connection pool. Nothing outside src/db should query it directly: use
 * `db`, which binds to a scoped connection (see scope.ts), or `withScope`.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Railway's managed Postgres terminates TLS with a certificate that is not
  // in the public trust store, so verification is disabled while transport
  // encryption is kept. Internal networking can turn SSL off entirely.
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  // Each in-flight request holds one connection for its duration, and a
  // Sideshift sync holds one for minutes.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

/**
 * Makes every connection the pool opens from now on start as `role`, using
 * the `role` startup parameter, so a connection that cannot take the role
 * fails to open rather than quietly running as the login role. Must be called
 * before the pool opens its first connection.
 */
export function useSessionRole(role: string): void {
  if (pool.totalCount > 0) {
    throw new Error("The session role must be set before the pool connects")
  }

  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`Invalid role name: ${role}`)
  }

  // pg-pool hands its options to every new client.
  ;(pool as unknown as { options: { options?: string } }).options.options =
    `-c role=${role}`
}

pool.on("error", (error) => {
  logger.error({ err: error }, "Unexpected Postgres pool error")
})
