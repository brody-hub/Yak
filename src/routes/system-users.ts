import { fromNodeHeaders } from "better-auth/node"
import { asc, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { auth } from "../auth/auth.js"
import {
  PANEL_PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  USER_ROLES,
  canAssignRole,
  canManageTargetUser,
  isValidRole,
} from "../auth/permissions.js"
import { db } from "../db/index.js"
import { session as sessionTable, user as userTable } from "../db/schema.js"
import { generateTemporaryPassword } from "../lib/crypto.js"
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.js"
import { serializeSystemUser } from "../lib/serializers.js"
import { getAuth } from "../middleware/auth.js"
import { requireUserManagement } from "../middleware/permissions.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { sendInviteEmail } from "../services/email.js"

export const systemUsersRouter: Router = Router()

const roleSchema = z.enum(USER_ROLES)
const permissionsSchema = z.array(z.enum(PANEL_PERMISSIONS)).max(
  PANEL_PERMISSIONS.length
)
const idParamSchema = z.object({ id: z.string().min(1) })

async function loadUser(id: string) {
  const [row] = await db
    .select()
    .from(userTable)
    .where(eq(userTable.id, id))
    .limit(1)

  if (!row) {
    throw new NotFoundError("User")
  }

  return row
}

/** Static metadata so the panel renders roles and permissions from one source. */
systemUsersRouter.get("/meta", (_req, res) => {
  res.json({
    data: {
      roles: USER_ROLES.map((role) => ({
        id: role,
        label: ROLE_LABELS[role],
        description: ROLE_DESCRIPTIONS[role],
      })),
      permissions: PANEL_PERMISSIONS,
    },
  })
})

systemUsersRouter.get("/", async (_req, res) => {
  const rows = await db
    .select()
    .from(userTable)
    .orderBy(asc(userTable.createdAt))

  res.json({ data: rows.map(serializeSystemUser) })
})

systemUsersRouter.get(
  "/:id",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const row = await loadUser(req.params.id as string)
    res.json({ data: serializeSystemUser(row) })
  }
)

/**
 * Invite flow.
 *
 * Creates the account with a random temporary password, emails it, and marks
 * the account so the panel forces a replacement on first sign in. There is no
 * public sign-up, so this is the only way an account comes into existence.
 */
systemUsersRouter.post(
  "/",
  requireUserManagement,
  validate({
    body: z
      .object({
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().toLowerCase().email(),
        role: roleSchema.default("member"),
        permissions: permissionsSchema.default([]),
      })
      .strict(),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const body = req.body as {
      name: string
      email: string
      role: (typeof USER_ROLES)[number]
      permissions: string[]
    }

    if (body.role === "owner" && actor.user.role !== "owner") {
      throw new ForbiddenError("Only an owner can invite another owner")
    }

    const [existing] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, body.email))
      .limit(1)

    if (existing) {
      throw new ConflictError("Someone with that email already has access")
    }

    const temporaryPassword = generateTemporaryPassword()

    // Better Auth owns credential creation; the role and permission columns
    // are ours, so they are written directly afterwards rather than through
    // the admin plugin's narrower role type.
    const created = await auth.api.createUser({
      body: {
        email: body.email,
        password: temporaryPassword,
        name: body.name,
      },
      headers: fromNodeHeaders(req.headers),
    })

    const [row] = await db
      .update(userTable)
      .set({
        role: body.role,
        // Owners and admins hold every permission implicitly, so only the
        // member grant list is worth persisting.
        permissions: body.role === "member" ? body.permissions : [],
        mustChangePassword: true,
        invitedByUserId: actor.user.id,
        invitedAt: new Date(),
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, created.user.id))
      .returning()

    if (!row) {
      throw new NotFoundError("User")
    }

    const delivered = await sendInviteEmail({
      to: row.email,
      name: row.name,
      temporaryPassword,
      invitedByName: actor.user.name,
    })

    await recordActivity({
      userId: actor.user.id,
      action: "invited",
      section: "user-management",
      summary: `Invited ${row.name} as ${ROLE_LABELS[body.role]}`,
      metadata: { invitedUserId: row.id, emailDelivered: delivered },
      ipAddress: req.ip,
    })

    res.status(201).json({
      data: serializeSystemUser(row),
      meta: {
        inviteEmailSent: delivered,
        // Without a configured mail provider the operator still needs a way to
        // hand the credential over.
        temporaryPassword: delivered ? undefined : temporaryPassword,
      },
    })
  }
)

systemUsersRouter.patch(
  "/:id",
  requireUserManagement,
  validate({
    params: idParamSchema,
    body: z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        role: roleSchema.optional(),
        permissions: permissionsSchema.optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: "Provide at least one field to update",
      }),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const target = await loadUser(req.params.id as string)
    const targetRole = isValidRole(target.role) ? target.role : "member"
    const body = req.body as {
      name?: string
      role?: (typeof USER_ROLES)[number]
      permissions?: string[]
    }

    const manage = canManageTargetUser(actor.user, {
      id: target.id,
      role: targetRole,
    })

    if (!manage.allowed) {
      throw new ForbiddenError(manage.reason)
    }

    if (body.role && body.role !== targetRole) {
      const assign = canAssignRole(actor.user, body.role, {
        id: target.id,
        role: targetRole,
      })

      if (!assign.allowed) {
        throw new ForbiddenError(assign.reason)
      }

      // Demoting the last owner would leave nobody able to administer the
      // instance.
      if (targetRole === "owner") {
        const owners = await db
          .select({ id: userTable.id })
          .from(userTable)
          .where(eq(userTable.role, "owner"))

        if (owners.length <= 1) {
          throw new BadRequestError(
            "This is the only owner. Promote someone else first."
          )
        }
      }

    }

    const nextRole = body.role ?? targetRole

    const [row] = await db
      .update(userTable)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.permissions
          ? { permissions: nextRole === "member" ? body.permissions : [] }
          : nextRole !== "member"
            ? { permissions: [] }
            : {}),
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, target.id))
      .returning()

    if (!row) {
      throw new NotFoundError("User")
    }

    await recordActivity({
      userId: actor.user.id,
      action: "updated",
      section: "user-management",
      summary: `Updated access for ${row.name}`,
      metadata: { targetUserId: row.id, changes: Object.keys(body) },
      ipAddress: req.ip,
    })

    res.json({ data: serializeSystemUser(row) })
  }
)

/** Deactivation keeps the audit trail intact where deletion would not. */
systemUsersRouter.post(
  "/:id/deactivate",
  requireUserManagement,
  validate({
    params: idParamSchema,
    body: z
      .object({ reason: z.string().trim().max(280).optional() })
      .strict()
      .default({}),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const target = await loadUser(req.params.id as string)
    const targetRole = isValidRole(target.role) ? target.role : "member"

    if (target.id === actor.user.id) {
      throw new BadRequestError("You cannot deactivate your own account")
    }

    const manage = canManageTargetUser(actor.user, {
      id: target.id,
      role: targetRole,
    })

    if (!manage.allowed) {
      throw new ForbiddenError(manage.reason)
    }

    const [row] = await db
      .update(userTable)
      .set({
        banned: true,
        banReason: (req.body as { reason?: string }).reason ?? "Access revoked",
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, target.id))
      .returning()

    // Banning only matters if the existing sessions die with it.
    await db.delete(sessionTable).where(eq(sessionTable.userId, target.id))

    await recordActivity({
      userId: actor.user.id,
      action: "updated",
      section: "user-management",
      summary: `Deactivated ${target.name}`,
      metadata: { targetUserId: target.id },
      ipAddress: req.ip,
    })

    res.json({ data: row ? serializeSystemUser(row) : null })
  }
)

systemUsersRouter.post(
  "/:id/reactivate",
  requireUserManagement,
  validate({ params: idParamSchema }),
  async (req, res) => {
    const actor = getAuth(req)
    const target = await loadUser(req.params.id as string)
    const targetRole = isValidRole(target.role) ? target.role : "member"

    const manage = canManageTargetUser(actor.user, {
      id: target.id,
      role: targetRole,
    })

    if (!manage.allowed) {
      throw new ForbiddenError(manage.reason)
    }

    const [row] = await db
      .update(userTable)
      .set({ banned: false, banReason: null, updatedAt: new Date() })
      .where(eq(userTable.id, target.id))
      .returning()

    await recordActivity({
      userId: actor.user.id,
      action: "updated",
      section: "user-management",
      summary: `Reactivated ${target.name}`,
      metadata: { targetUserId: target.id },
      ipAddress: req.ip,
    })

    res.json({ data: row ? serializeSystemUser(row) : null })
  }
)

/** Issues a fresh temporary password and re-sends the invite email. */
systemUsersRouter.post(
  "/:id/resend-invite",
  requireUserManagement,
  validate({ params: idParamSchema }),
  async (req, res) => {
    const actor = getAuth(req)
    const target = await loadUser(req.params.id as string)
    const targetRole = isValidRole(target.role) ? target.role : "member"

    const manage = canManageTargetUser(actor.user, {
      id: target.id,
      role: targetRole,
    })

    if (!manage.allowed) {
      throw new ForbiddenError(manage.reason)
    }

    const temporaryPassword = generateTemporaryPassword()

    await auth.api.setUserPassword({
      body: { userId: target.id, newPassword: temporaryPassword },
      headers: fromNodeHeaders(req.headers),
    })

    await db
      .update(userTable)
      .set({ mustChangePassword: true, invitedAt: new Date() })
      .where(eq(userTable.id, target.id))

    // The old credential is gone, so any session holding it should be too.
    await db.delete(sessionTable).where(eq(sessionTable.userId, target.id))

    const delivered = await sendInviteEmail({
      to: target.email,
      name: target.name,
      temporaryPassword,
      invitedByName: actor.user.name,
    })

    await recordActivity({
      userId: actor.user.id,
      action: "invited",
      section: "user-management",
      summary: `Resent invite to ${target.name}`,
      metadata: { targetUserId: target.id, emailDelivered: delivered },
      ipAddress: req.ip,
    })

    res.json({
      data: { ok: true },
      meta: {
        inviteEmailSent: delivered,
        temporaryPassword: delivered ? undefined : temporaryPassword,
      },
    })
  }
)

systemUsersRouter.delete(
  "/:id",
  requireUserManagement,
  validate({ params: idParamSchema }),
  async (req, res) => {
    const actor = getAuth(req)
    const target = await loadUser(req.params.id as string)
    const targetRole = isValidRole(target.role) ? target.role : "member"

    if (target.id === actor.user.id) {
      throw new BadRequestError("You cannot delete your own account")
    }

    if (targetRole === "owner") {
      throw new ForbiddenError(
        "Owners cannot be deleted. Change the role first."
      )
    }

    const manage = canManageTargetUser(actor.user, {
      id: target.id,
      role: targetRole,
    })

    if (!manage.allowed) {
      throw new ForbiddenError(manage.reason)
    }

    await db.delete(userTable).where(eq(userTable.id, target.id))

    await recordActivity({
      userId: actor.user.id,
      action: "deleted",
      section: "user-management",
      summary: `Deleted ${target.name}`,
      metadata: { targetEmail: target.email },
      ipAddress: req.ip,
    })

    res.json({ data: { ok: true } })
  }
)
