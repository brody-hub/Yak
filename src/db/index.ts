import { drizzle } from "drizzle-orm/node-postgres"

import { logger } from "../logger.js"
import { APP_ROLE, describeRole, withLoginConnection } from "./app-role.js"
import { pool, useSessionRole } from "./pool.js"
import * as schema from "./schema.js"
import { type Database, resolveDatabase } from "./scope.js"

export { pool } from "./pool.js"
export type { Database } from "./scope.js"

const unscoped = drizzle(pool, { schema })

/**
 * The database handle every module imports.
 *
 * Inside a scope (a panel request, an API key request, a background job that
 * opened one) it is the connection bound to that scope, so row level security
 * applies to the caller's tenant. Outside any scope it is the plain pool, on
 * which customer tables return no rows at all. Either way a query cannot read
 * across tenants.
 */
export const db: Database = new Proxy(unscoped, {
  get(target, property, receiver) {
    const current = resolveDatabase(target)

    if (current === target) {
      return Reflect.get(target, property, receiver)
    }

    const value = Reflect.get(current, property, current)

    return typeof value === "function" ? value.bind(current) : value
  },
})

/**
 * Row level security is skipped for superusers and roles with BYPASSRLS, and
 * `FORCE ROW LEVEL SECURITY` only reaches table owners. The application must
 * work as a plain role for the policies to mean anything.
 *
 * When DATABASE_URL logs in as a role that bypasses them, the pool switches
 * every connection to APP_ROLE, which migrations create for exactly this
 * case. Call before anything else touches the pool. Returns the role the pool
 * actually runs as.
 */
export async function checkDatabaseRole(): Promise<{
  role: string
  bypassesRowSecurity: boolean
}> {
  const login = await withLoginConnection(describeRole)

  if (login.bypassesRowSecurity && login.canAssumeAppRole) {
    useSessionRole(APP_ROLE)
    logger.info(
      { loginRole: login.role, sessionRole: APP_ROLE },
      "Login role bypasses row level security; connections switch role"
    )
  }

  const result = await pool.query<{
    rolname: string
    rolsuper: boolean
    rolbypassrls: boolean
  }>(
    "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user"
  )

  const row = result.rows[0]

  return {
    role: row?.rolname ?? "unknown",
    bypassesRowSecurity: Boolean(row?.rolsuper || row?.rolbypassrls),
  }
}

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
