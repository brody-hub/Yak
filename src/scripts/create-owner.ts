import { count, eq } from "drizzle-orm"

import { SUPER_ADMIN_ROLE } from "../auth/permissions.js"
import { closeDatabase, db } from "../db/index.js"
import { apps, tenants, type Tenant, user as userTable } from "../db/schema.js"
import { withStaffScope } from "../db/scope.js"
import { env } from "../env.js"
import { newId } from "../lib/crypto.js"
import { logger } from "../logger.js"
import { sendInviteEmail } from "../services/email.js"
import {
  invitePanelUser,
  issueTemporaryPassword,
} from "../services/panel-accounts.js"

export type CreateAccountResult =
  | {
      status: "created"
      email: string
      temporaryPassword: string
      inviteEmailSent: boolean
    }
  | { status: "exists"; email: string }
  | { status: "skipped"; reason: string }

export type ResetPasswordResult =
  | {
      status: "reset"
      email: string
      /** Null when the password was emailed; printing it is then unnecessary. */
      temporaryPassword: string | null
      emailSent: boolean
    }
  | { status: "skipped"; reason: string }

async function emailTaken(email: string) {
  return Boolean(await emailOwner(email))
}

async function emailOwner(email: string) {
  const [existing] = await db
    .select({ id: userTable.id, role: userTable.role })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1)

  return existing ?? null
}

/**
 * Bootstraps a super admin.
 *
 * Staff are never created through sign up, so this is how the first super
 * admin on a deployment comes into existence. That super admin then manages
 * customer accounts from the admin console.
 */
export async function createSuperAdminAccount(options: {
  email: string
  name?: string
}): Promise<CreateAccountResult> {
  const email = options.email.trim().toLowerCase()
  const name = options.name?.trim() || "Super admin"

  if (!email) {
    return { status: "skipped", reason: "No email provided" }
  }

  const existing = await emailOwner(email)

  if (existing?.role === SUPER_ADMIN_ROLE) {
    return { status: "exists", email }
  }

  // Emails are unique across all of Yak, and a super admin belongs to no
  // customer, so a customer's login cannot double as one.
  if (existing) {
    return {
      status: "skipped",
      reason: `${email} already signs in to a customer account; use a different email for the super admin`,
    }
  }

  const { temporaryPassword } = await invitePanelUser({
    tenantId: null,
    email,
    name,
    role: SUPER_ADMIN_ROLE,
  })

  const delivered = await sendInviteEmail({
    to: email,
    name,
    temporaryPassword,
    invitedByName: "Setup",
    workspaceName: env.APP_NAME,
  })

  return {
    status: "created",
    email,
    temporaryPassword,
    inviteEmailSent: delivered,
  }
}

/**
 * An account always has at least one app, named after it, so its owner can
 * start connecting straight away. The admin console creates it with the
 * account; this covers an account that somehow has none. The `apps` table is
 * behind row level security, so this runs as staff.
 */
async function ensureFirstApp(tenant: Tenant) {
  await withStaffScope(async (staff) => {
    const [existing] = await staff
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.tenantId, tenant.id))
      .limit(1)

    if (existing) {
      return
    }

    await staff.insert(apps).values({
      id: newId(),
      tenantId: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
    })
  })
}

/**
 * Adds an owner to an existing tenant. The admin console does the same; this
 * is for scripting and for recovering an account whose owners are all gone.
 */
export async function createOwnerAccount(options: {
  tenantSlug: string
  email: string
  name?: string
}): Promise<CreateAccountResult> {
  const email = options.email.trim().toLowerCase()
  const name = options.name?.trim() || "Owner"

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, options.tenantSlug.trim().toLowerCase()))
    .limit(1)

  if (!tenant) {
    return {
      status: "skipped",
      reason: `No account with slug ${options.tenantSlug}`,
    }
  }

  if (await emailTaken(email)) {
    return { status: "exists", email }
  }

  await ensureFirstApp(tenant)

  const { temporaryPassword } = await invitePanelUser({
    tenantId: tenant.id,
    email,
    name,
    role: "owner",
  })

  const delivered = await sendInviteEmail({
    to: email,
    name,
    temporaryPassword,
    invitedByName: "Setup",
    workspaceName: tenant.name,
  })

  return {
    status: "created",
    email,
    temporaryPassword,
    inviteEmailSent: delivered,
  }
}

/** Only runs while no super admin exists, so a redeploy cannot mint another. */
export async function bootstrapSuperAdminFromEnv(): Promise<CreateAccountResult | null> {
  if (!env.SUPER_ADMIN_EMAIL) {
    return null
  }

  const [row] = await db
    .select({ total: count() })
    .from(userTable)
    .where(eq(userTable.role, SUPER_ADMIN_ROLE))

  if ((row?.total ?? 0) > 0) {
    return { status: "skipped", reason: "A super admin already exists" }
  }

  return createSuperAdminAccount({
    email: env.SUPER_ADMIN_EMAIL,
    name: env.SUPER_ADMIN_NAME,
  })
}

/**
 * Issues a new temporary password for any account. Emailed when an email
 * service is configured; only otherwise is it handed back to be printed, so a
 * production log never carries a live credential.
 */
export async function resetAccountPassword(
  email: string
): Promise<ResetPasswordResult> {
  const normalized = email.trim().toLowerCase()

  const [existing] = await db
    .select({ id: userTable.id, email: userTable.email, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.email, normalized))
    .limit(1)

  if (!existing) {
    return { status: "skipped", reason: `No account for ${normalized}` }
  }

  const temporaryPassword = await issueTemporaryPassword(existing.id)

  const emailSent = env.email.configured
    ? await sendInviteEmail({
        to: existing.email,
        name: existing.name,
        temporaryPassword,
        invitedByName: `${env.APP_NAME} setup`,
        workspaceName: env.APP_NAME,
      })
    : false

  return {
    status: "reset",
    email: existing.email,
    temporaryPassword: env.email.configured ? null : temporaryPassword,
    emailSent,
  }
}

/**
 * One-shot boot path. Set SUPER_ADMIN_RESET_PASSWORD=true, then remove it
 * after.
 */
export async function resetSuperAdminFromEnv(): Promise<ResetPasswordResult | null> {
  if (process.env.SUPER_ADMIN_RESET_PASSWORD !== "true") {
    return null
  }

  if (!env.SUPER_ADMIN_EMAIL) {
    return { status: "skipped", reason: "SUPER_ADMIN_EMAIL not set" }
  }

  // Only ever a super admin: an environment variable must not be a way to
  // re-key a customer's login (and print its password to the deploy log).
  const owner = await emailOwner(env.SUPER_ADMIN_EMAIL.trim().toLowerCase())

  if (owner?.role !== SUPER_ADMIN_ROLE) {
    return {
      status: "skipped",
      reason: `${env.SUPER_ADMIN_EMAIL} is not a super admin`,
    }
  }

  return resetAccountPassword(env.SUPER_ADMIN_EMAIL)
}

function printCredentials(email: string, temporaryPassword: string) {
  console.log("\n  Email was not sent. Use these credentials to sign in:\n")
  console.log(`    Email:    ${email}`)
  console.log(`    Password: ${temporaryPassword}\n`)
  console.log("  You will be asked to change it immediately.\n")
}

const USAGE = [
  "Usage:",
  '  npm run create:super-admin -- you@example.com "Your Name"',
  '  npm run create:owner -- <account-slug> owner@example.com "Owner Name"',
  "  npm run create:super-admin -- you@example.com --reset",
].join("\n")

async function main() {
  const reset = process.argv.includes("--reset")
  const superAdmin = process.argv.includes("--super-admin")
  const args = process.argv
    .slice(2)
    .filter((arg) => arg !== "--reset" && arg !== "--super-admin")

  if (reset) {
    const email = args[0] ?? env.SUPER_ADMIN_EMAIL
    if (!email) {
      throw new Error(USAGE)
    }

    const result = await resetAccountPassword(email)

    if (result.status === "skipped") {
      throw new Error(result.reason)
    }

    logger.info({ email: result.email }, "Password reset")

    if (result.temporaryPassword) {
      printCredentials(result.email, result.temporaryPassword)
    } else if (result.emailSent) {
      console.log(`\n  A temporary password was emailed to ${result.email}.\n`)
    } else {
      throw new Error(
        "The password email could not be sent. Fix the email service and run the reset again."
      )
    }

    return
  }

  const result = superAdmin
    ? await createSuperAdminAccount({
        email: args[0] ?? env.SUPER_ADMIN_EMAIL ?? "",
        name: args[1] ?? env.SUPER_ADMIN_NAME,
      })
    : args.length >= 2
      ? await createOwnerAccount({
          tenantSlug: args[0]!,
          email: args[1]!,
          name: args[2],
        })
      : null

  if (!result) {
    throw new Error(USAGE)
  }

  if (result.status === "exists") {
    logger.info(
      { email: result.email },
      "That account already exists - nothing to do"
    )
    return
  }

  if (result.status === "skipped") {
    throw new Error(result.reason)
  }

  logger.info(
    {
      email: result.email,
      role: superAdmin ? SUPER_ADMIN_ROLE : "owner",
      inviteEmailSent: result.inviteEmailSent,
    },
    "Account created"
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
      logger.error({ err: error }, "Could not create account")
      process.exitCode = 1
    })
    .finally(async () => {
      await closeDatabase()
    })
}
