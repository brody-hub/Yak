import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { env } from "../env.js"
import { logger } from "../logger.js"
import * as schema from "./schema.js"

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Railway's managed Postgres terminates TLS with a certificate that is not
  // in the public trust store, so verification is disabled while transport
  // encryption is kept. Internal networking can turn SSL off entirely.
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

pool.on("error", (error) => {
  logger.error({ err: error }, "Unexpected Postgres pool error")
})

export const db = drizzle(pool, { schema })

export type Database = typeof db

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await pool.query("select 1")
    return true
  } catch (error) {
    logger.error({ err: error }, "Database health check failed")
    return false
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end()
}
