import { and, eq } from "drizzle-orm"

import { auth } from "../auth/auth.js"
import type { AccountRole } from "../auth/permissions.js"
import { db } from "../db/index.js"
import {
  account as accountTable,
  session as sessionTable,
  user as userTable,
} from "../db/schema.js"
import { generateTemporaryPassword } from "../lib/crypto.js"
import { ConflictError, NotFoundError } from "../lib/errors.js"

/**
 * Creating and re-keying panel accounts.
 *
 * Accounts are written through Better Auth's internal adapter rather than the
 * admin plugin's HTTP-shaped API: the plugin knows nothing about tenants, and
 * the `user_tenant_matches_role` check means the tenant and role must be set
 * in the same insert that creates the row.
 */

export async function createPanelUser(params: {
  /** Null only for a super admin. */
  tenantId: string | null
  email: string
  name: string
  role: AccountRole
  permissions?: string[]
  invitedByUserId?: string | null
  /**
   * A password the person chose themselves, at sign up. They then neither
   * get a temporary one nor have to change it, but must verify their email
   * before they can sign in. Invites are verified by the act of using them.
   */
  password?: string
}) {
  const email = params.email.trim().toLowerCase()

  // Emails are unique across every tenant, because sign-in is by email alone.
  const [existing] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1)

  if (existing) {
    throw new ConflictError("Someone with that email already has an account")
  }

  const context = await auth.$context
  const selfChosen = params.password !== undefined
  const temporaryPassword = selfChosen ? null : generateTemporaryPassword()

  const created = await context.internalAdapter.createUser({
    name: params.name,
    email,
    emailVerified: !selfChosen,
    tenantId: params.tenantId,
    role: params.role,
  })

  await context.internalAdapter.linkAccount({
    userId: created.id,
    accountId: created.id,
    providerId: "credential",
    password: await context.password.hash(params.password ?? temporaryPassword!),
  })

  const [row] = await db
    .update(userTable)
    .set({
      role: params.role,
      // Owners and admins hold every permission implicitly, so only the
      // member grant list is worth persisting.
      permissions: params.role === "member" ? (params.permissions ?? []) : [],
      mustChangePassword: !selfChosen,
      invitedByUserId: params.invitedByUserId ?? null,
      invitedAt: selfChosen ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(userTable.id, created.id))
    .returning()

  if (!row) {
    throw new NotFoundError("User")
  }

  return { user: row, temporaryPassword }
}

/** createPanelUser for an invite, where a temporary password always exists. */
export async function invitePanelUser(
  params: Omit<Parameters<typeof createPanelUser>[0], "password">
) {
  const created = await createPanelUser(params)
  return { user: created.user, temporaryPassword: created.temporaryPassword! }
}

/**
 * Replaces the account's password with a fresh temporary one, forces a change
 * on next sign in, and ends every existing session.
 */
export async function issueTemporaryPassword(userId: string) {
  const context = await auth.$context
  const temporaryPassword = generateTemporaryPassword()
  const password = await context.password.hash(temporaryPassword)

  const [credential] = await db
    .select({ id: accountTable.id })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, userId),
        eq(accountTable.providerId, "credential")
      )
    )
    .limit(1)

  if (credential) {
    await db
      .update(accountTable)
      .set({ password, updatedAt: new Date() })
      .where(eq(accountTable.id, credential.id))
  } else {
    await context.internalAdapter.linkAccount({
      userId,
      accountId: userId,
      providerId: "credential",
      password,
    })
  }

  await db
    .update(userTable)
    .set({ mustChangePassword: true, invitedAt: new Date(), updatedAt: new Date() })
    .where(eq(userTable.id, userId))

  // The old credential is gone, so any session holding it should be too.
  await db.delete(sessionTable).where(eq(sessionTable.userId, userId))

  return temporaryPassword
}
