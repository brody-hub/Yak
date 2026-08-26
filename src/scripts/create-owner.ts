import { and, count, eq } from "drizzle-orm"

import { auth } from "../auth/auth.js"
import { closeDatabase, db } from "../db/index.js"
import {
  account as accountTable,
  session as sessionTable,
  user as userTable,
} from "../db/schema.js"
import { env } from "../env.js"
import { generateTemporaryPassword } from "../lib/crypto.js"
import { logger } from "../logger.js"
import { sendInviteEmail } from "../services/email.js"

export type CreateOwnerResult =
  | { status: "created"; email: string; temporaryPassword: string; inviteEmailSent: boolean }
  | { status: "exists"; email: string }
  | { status: "skipped"; reason: string }

export type ResetOwnerResult =
  | { status: "reset"; email: string; temporaryPassword: string }
  | { status: "skipped"; reason: string }

/**
 * Bootstraps the first owner.
 *
 * There is no public sign-up, so this is the only way to create an account on a
 * fresh deployment. Everyone after this is invited from the panel.
 */
export async function createOwnerAccount(options: {
  email: string
  name?: string
}): Promise<CreateOwnerResult> {
  const email = options.email.trim().toLowerCase()
  const name = options.name?.trim() || "Owner"

  if (!email) {
    return { status: "skipped", reason: "No email provided" }
  }

  const [existing] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1)

  if (existing) {
    return { status: "exists", email }
  }

  const context = await auth.$context
  const temporaryPassword = generateTemporaryPassword()

  const created = await context.internalAdapter.createUser({
    name,
    email,
    emailVerified: true,
    role: "owner",
  })

  await context.internalAdapter.linkAccount({
    userId: created.id,
    accountId: created.id,
    providerId: "credential",
    password: await context.password.hash(temporaryPassword),
  })

  await db
    .update(userTable)
    .set({ role: "owner", mustChangePassword: true, invitedAt: new Date() })
    .where(eq(userTable.id, created.id))

  const delivered = await sendInviteEmail({
    to: email,
    name,
    temporaryPassword,
    invitedByName: "Setup",
  })

  return {
    status: "created",
    email,
    temporaryPassword,
    inviteEmailSent: delivered,
  }
}

/** Only runs when the users table is empty, so a redeploy cannot mint a second owner. */
export async function bootstrapOwnerFromEnv(): Promise<CreateOwnerResult | null> {
  if (!env.OWNER_EMAIL) {
    return null
  }

  const [row] = await db.select({ total: count() }).from(userTable)
  if ((row?.total ?? 0) > 0) {
    return { status: "skipped", reason: "Users already exist" }
  }

  return createOwnerAccount({
    email: env.OWNER_EMAIL,
    name: env.OWNER_NAME,
  })
}

/**
 * Issues a new temporary password for an existing owner. Used when email is
 * not configured and the first-boot password was never delivered.
 */
export async function resetOwnerPassword(email: string): Promise<ResetOwnerResult> {
  const normalized = email.trim().toLowerCase()

  const [existing] = await db
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.email, normalized))
    .limit(1)

  if (!existing) {
    return { status: "skipped", reason: `No account for ${normalized}` }
  }

  const context = await auth.$context
  const temporaryPassword = generateTemporaryPassword()
  const password = await context.password.hash(temporaryPassword)

  const [credential] = await db
    .select({ id: accountTable.id })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, existing.id),
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
      userId: existing.id,
      accountId: existing.id,
      providerId: "credential",
      password,
    })
  }

  await db
    .update(userTable)
    .set({ mustChangePassword: true, updatedAt: new Date() })
    .where(eq(userTable.id, existing.id))

  await db.delete(sessionTable).where(eq(sessionTable.userId, existing.id))

  return { status: "reset", email: existing.email, temporaryPassword }
}

/** One-shot boot path. Set OWNER_RESET_PASSWORD=true, then remove it after. */
export async function resetOwnerFromEnv(): Promise<ResetOwnerResult | null> {
  if (process.env.OWNER_RESET_PASSWORD !== "true") {
    return null
  }

  if (!env.OWNER_EMAIL) {
    return { status: "skipped", reason: "OWNER_EMAIL not set" }
  }

  return resetOwnerPassword(env.OWNER_EMAIL)
}

function printCredentials(email: string, temporaryPassword: string) {
  console.log("\n  Email was not sent. Use these credentials to sign in:\n")
  console.log(`    Email:    ${email}`)
  console.log(`    Password: ${temporaryPassword}\n`)
  console.log("  You will be asked to change it immediately.\n")
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--reset")
  const reset = process.argv.includes("--reset")
  const email = (args[0] ?? env.OWNER_EMAIL)?.trim().toLowerCase()
  const name = args[1] ?? env.OWNER_NAME ?? "Owner"

  if (!email) {
    throw new Error(
      "Provide an email: npm run create:owner -- you@example.com \"Your Name\""
    )
  }

  if (reset) {
    const resetResult = await resetOwnerPassword(email)

    if (resetResult.status === "skipped") {
      throw new Error(resetResult.reason)
    }

    logger.info({ email: resetResult.email }, "Owner password reset")
    printCredentials(resetResult.email, resetResult.temporaryPassword)
    return
  }

  const result = await createOwnerAccount({ email, name })

  if (result.status === "exists") {
    logger.info({ email: result.email }, "That account already exists - nothing to do")
    return
  }

  if (result.status === "skipped") {
    throw new Error(result.reason)
  }

  logger.info(
    {
      email: result.email,
      role: "owner",
      inviteEmailSent: result.inviteEmailSent,
    },
    "Owner created"
  )

  if (!result.inviteEmailSent) {
    printCredentials(result.email, result.temporaryPassword)
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("create-owner.ts") ||
  process.argv[1]?.endsWith("create-owner.js")

if (isDirectRun) {
  main()
    .catch((error) => {
      logger.error({ err: error }, "Could not create owner")
      process.exitCode = 1
    })
    .finally(async () => {
      await closeDatabase()
    })
}
