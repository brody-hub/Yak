import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Client } from "pg"

import { env } from "../env.js"
import { logger } from "../logger.js"
import { APP_ROLE, describeRole, withLoginConnection } from "./app-role.js"

/**
 * Migrations need to own the tables they alter, so they connect as the
 * database owner (MIGRATION_DATABASE_URL) rather than the restricted role the
 * server runs as. With only DATABASE_URL set, that is used for both, which is
 * the local development setup.
 *
 * Customer tables FORCE row level security, which binds the owner too. A
 * migration that moves customer data would otherwise match no rows and report
 * success. `row_security = off` turns that into an error instead: a superuser
 * or BYPASSRLS owner is unaffected, and any other owner is told loudly that
 * the statement would have been filtered.
 *
 * When DATABASE_URL itself logs in as a role that bypasses row level security
 * (a single Railway `postgres` user, say), the server works as APP_ROLE
 * instead (see app-role.ts). That role is set up here, before any migration
 * runs: if it cannot be, nothing is migrated and the deploy fails while the
 * running version keeps its schema.
 */
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL?.trim() || env.DATABASE_URL

  const client = new Client({
    connectionString: url,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  })

  await client.connect()

  try {
    await client.query("set row_security = off")

    const login = await withLoginConnection(describeRole)
    const needsAppRole = login.bypassesRowSecurity

    if (needsAppRole) {
      await prepareAppRole(client, login.role)
    }

    logger.info("Running database migrations")
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" })
    logger.info("Migrations complete")

    if (needsAppRole) {
      await grantAppRole(client)
    }
  } finally {
    await client.end()
  }
}

/**
 * Creates APP_ROLE when missing (it never logs in itself) and lets the login
 * role switch to it. Runs before migrating so a failure changes nothing.
 */
async function prepareAppRole(client: Client, loginRole: string) {
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} nologin nosuperuser nobypassrls nocreatedb nocreaterole;
      end if;
    end
    $$
  `)

  const login = await withLoginConnection(describeRole)

  if (!login.canAssumeAppRole) {
    // A superuser can take any role; anything else needs membership.
    await client.query(
      `grant ${APP_ROLE} to ${client.escapeIdentifier(loginRole)}`
    )
  }

  const check = await withLoginConnection(describeRole)

  if (!check.canAssumeAppRole) {
    throw new Error(
      `${loginRole} bypasses row level security and cannot switch to ${APP_ROLE}; nothing was migrated`
    )
  }

  // Before migrating too, so a grant failure also leaves the schema alone.
  await grantAppRole(client)

  logger.info({ loginRole, appRole: APP_ROLE }, "App role ready")
}

/** Data access on every table, including ones migrations just created. */
async function grantAppRole(client: Client) {
  await client.query(`grant usage on schema public to ${APP_ROLE}`)
  await client.query(
    `grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`
  )
  await client.query(
    `grant usage, select on all sequences in schema public to ${APP_ROLE}`
  )
  await client.query(
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${APP_ROLE}`
  )
  await client.query(
    `alter default privileges in schema public grant usage, select on sequences to ${APP_ROLE}`
  )
}

main().catch((error) => {
  logger.error({ err: error }, "Migration failed")
  process.exitCode = 1
})
