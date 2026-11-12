import { Client } from "pg"

import { env } from "../env.js"

/**
 * The plain role the server works as. Row level security is skipped for
 * superusers and BYPASSRLS roles, so when DATABASE_URL logs in as one (as
 * Railway's default `postgres` user does) every pooled connection switches to
 * this role at startup instead. A deployment that already connects as a plain
 * role, as docs/DEPLOYMENT.md describes, never uses it.
 */
export const APP_ROLE = "yak_app"

export type RoleInfo = {
  role: string
  bypassesRowSecurity: boolean
  /** Whether the login role can switch to APP_ROLE, which must not bypass. */
  canAssumeAppRole: boolean
}

const ROLE_QUERY = `
  select
    r.rolname,
    r.rolsuper or r.rolbypassrls as bypasses,
    exists (
      select 1 from pg_roles a
      where a.rolname = $1
        and not a.rolsuper
        and not a.rolbypassrls
        and pg_has_role(current_user, a.oid, 'MEMBER')
    ) as can_assume
  from pg_roles r
  where r.rolname = current_user
`

export async function describeRole(client: Client): Promise<RoleInfo> {
  const result = await client.query<{
    rolname: string
    bypasses: boolean
    can_assume: boolean
  }>(ROLE_QUERY, [APP_ROLE])
  const row = result.rows[0]

  return {
    role: row?.rolname ?? "unknown",
    bypassesRowSecurity: Boolean(row?.bypasses),
    canAssumeAppRole: Boolean(row?.can_assume),
  }
}

/** A single connection as DATABASE_URL's login role, outside the pool. */
export async function withLoginConnection<T>(
  run: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  })

  await client.connect()

  try {
    return await run(client)
  } finally {
    await client.end()
  }
}
