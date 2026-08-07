import { eq } from "drizzle-orm"

import { auth } from "../auth/auth.js"
import { closeDatabase, db } from "../db/index.js"
import { user as userTable } from "../db/schema.js"
import { env } from "../env.js"
import { generateTemporaryPassword } from "../lib/crypto.js"
import { logger } from "../logger.js"
import { sendInviteEmail } from "../services/email.js"

/**
 * Bootstraps the first owner.
 *
 * There is no public sign-up, so this script is the only way to create an
 * account on a fresh deployment. Everyone after this is invited from the panel.
 */
async function main() {
  const email = (process.argv[2] ?? env.OWNER_EMAIL)?.trim().toLowerCase()
  const name = process.argv[3] ?? env.OWNER_NAME ?? "Owner"

  if (!email) {
    throw new Error(
      "Provide an email: npm run create:owner -- you@example.com \"Your Name\""
    )
  }

  const [existing] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1)

  if (existing) {
    logger.info({ email }, "That account already exists - nothing to do")
    return
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

  logger.info({ email, role: "owner", inviteEmailSent: delivered }, "Owner created")

  if (!delivered) {
    // Nothing else can be done from the panel until someone can sign in.
    console.log("\n  Email was not sent. Use these credentials to sign in:\n")
    console.log(`    Email:    ${email}`)
    console.log(`    Password: ${temporaryPassword}\n`)
    console.log("  You will be asked to change it immediately.\n")
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, "Could not create owner")
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDatabase()
  })
