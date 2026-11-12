import { randomBytes } from "node:crypto"

import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"

import { db } from "../db/index.js"
import {
  apps,
  appSettings,
  type PlanTier,
  tenants,
  user as userTable,
} from "../db/schema.js"
import { newId } from "../lib/crypto.js"
import { ConflictError, NotFoundError } from "../lib/errors.js"

type Executor = Pick<typeof db, "update" | "select">

export async function loadTenant(tenantId: string) {
  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)

  if (!row) {
    throw new NotFoundError("Account")
  }

  return row
}

/** One of the tenant's apps; another tenant's app id is a 404. */
export async function loadApp(tenantId: string, appId: string) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.tenantId, tenantId)))
    .limit(1)

  if (!row) {
    throw new NotFoundError("App")
  }

  return row
}

/**
 * Hands out the tenant's next ticket number. The row lock taken by the update
 * serialises concurrent creates within one tenant, so pass the transaction
 * that inserts the ticket to keep a rolled back create from burning a number.
 */
export async function nextTicketNumber(
  tx: Executor,
  tenantId: string
): Promise<number> {
  const [row] = await tx
    .update(tenants)
    .set({ ticketSeq: sql`${tenants.ticketSeq} + 1` })
    .where(eq(tenants.id, tenantId))
    .returning({ value: tenants.ticketSeq })

  if (!row) {
    throw new NotFoundError("Account")
  }

  return row.value
}

/** Same as nextTicketNumber, for support reports. */
export async function nextReportNumber(
  tx: Executor,
  tenantId: string
): Promise<number> {
  const [row] = await tx
    .update(tenants)
    .set({ reportSeq: sql`${tenants.reportSeq} + 1` })
    .where(eq(tenants.id, tenantId))
    .returning({ value: tenants.reportSeq })

  if (!row) {
    throw new NotFoundError("Account")
  }

  return row.value
}

/* -------------------------------------------------------------------------- */
/* Creating accounts                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Slugs in URLs and paths that a tenant should never be able to claim. The
 * first app reuses the account's slug, so the app reserved words are here too.
 */
const RESERVED_TENANT_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "www",
  "yak",
  "default",
  "new",
  "all",
])

const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/

export const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    TENANT_SLUG_PATTERN,
    "Use 2 to 40 lowercase letters, numbers, or dashes, starting with a letter or number"
  )
  .refine((value) => !RESERVED_TENANT_SLUGS.has(value), "That slug is reserved")

export async function tenantSlugTaken(slug: string) {
  const [taken] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1)

  return Boolean(taken)
}

/**
 * A free slug derived from an account name, for sign ups that never see it.
 * "Acme Labs" becomes `acme-labs`, or `acme-labs-x7k2` when that is taken.
 */
export async function availableTenantSlug(name: string): Promise<string> {
  let base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34)
    .replace(/-+$/, "")

  if (base.length < 2) {
    base = "account"
  }

  const candidates = [base]

  for (let attempt = 0; attempt < 5; attempt += 1) {
    candidates.push(`${base}-${randomBytes(3).toString("hex").slice(0, 4)}`)
  }

  for (const candidate of candidates) {
    if (
      TENANT_SLUG_PATTERN.test(candidate) &&
      !RESERVED_TENANT_SLUGS.has(candidate) &&
      !(await tenantSlugTaken(candidate))
    ) {
      return candidate
    }
  }

  throw new ConflictError("Could not pick an address for this account; try again")
}

/** Emails are unique across every tenant, because sign in is by email alone. */
export async function findUserByEmail(email: string) {
  const [existing] = await db
    .select()
    .from(userTable)
    .where(eq(userTable.email, email.trim().toLowerCase()))
    .limit(1)

  return existing ?? null
}

export async function assertEmailFree(email: string) {
  if (await findUserByEmail(email)) {
    throw new ConflictError("Someone with that email already has an account")
  }
}

/**
 * Inserts an account with its branding row and its first app, named after
 * it, so the owner can start connecting straight away and rename it later.
 *
 * Inserting a tenant is a staff operation under row level security, so this
 * runs in the staff scope: a super admin's request, or `withStaffScope` for a
 * sign up. The owner is added separately (see createPanelUser).
 */
export async function createTenantWithFirstApp(params: {
  name: string
  slug: string
  createdByUserId: string | null
  signupSource: "admin" | "self_serve"
  pendingPlan?: PlanTier | null
  pendingInterval?: "monthly" | "annual" | null
}) {
  const tenantId = newId()

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(tenants)
      .values({
        id: tenantId,
        name: params.name,
        slug: params.slug,
        createdByUserId: params.createdByUserId,
        signupSource: params.signupSource,
        pendingPlan: params.pendingPlan ?? null,
        pendingInterval: params.pendingInterval ?? null,
      })
      .returning()

    await tx.insert(appSettings).values({ tenantId, brandName: params.name })

    await tx.insert(apps).values({
      id: newId(),
      tenantId,
      name: params.name,
      slug: params.slug,
      createdByUserId: params.createdByUserId,
    })

    return created!
  })
}
