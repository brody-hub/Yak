import { fromNodeHeaders } from "better-auth/node"
import { desc, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { auth } from "../auth/auth.js"
import { db } from "../db/index.js"
import { activityLog, user as userTable } from "../db/schema.js"
import { appendAuthCookies } from "../lib/auth-cookies.js"
import { BadRequestError, NotFoundError } from "../lib/errors.js"
import { serializeActivity, serializeCurrentUser } from "../lib/serializers.js"
import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { imageExists } from "../services/images.js"

export const meRouter: Router = Router()

async function loadCurrentUser(id: string) {
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

meRouter.get("/", async (req, res) => {
  const { user } = getAuth(req)
  const row = await loadCurrentUser(user.id)

  res.json({ data: serializeCurrentUser(row) })
})

meRouter.patch(
  "/",
  validate({
    body: z
      .object({ name: z.string().trim().min(1).max(120) })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const { name } = req.body as { name: string }

    const [row] = await db
      .update(userTable)
      .set({ name, updatedAt: new Date() })
      .where(eq(userTable.id, user.id))
      .returning()

    if (!row) {
      throw new NotFoundError("User")
    }

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "account",
      summary: "Updated profile name",
      ipAddress: req.ip,
    })

    res.json({ data: serializeCurrentUser(row) })
  }
)

/**
 * Password change. Also the exit path from the forced change an invite puts on
 * a new account, so it must stay reachable while `mustChangePassword` is set.
 */
meRouter.post(
  "/password",
  validate({
    body: z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(12).max(128),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string
      newPassword: string
    }

    if (currentPassword === newPassword) {
      throw new BadRequestError(
        "Your new password must be different from the current one"
      )
    }

    // revokeOtherSessions deletes every session (including this one) and
    // issues a replacement cookie. That Set-Cookie must reach the browser or
    // the next authenticated call will 401 with the stale cookie.
    const changed = await auth.api.changePassword({
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    })

    appendAuthCookies(res, changed.headers)

    const [row] = await db
      .update(userTable)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(userTable.id, user.id))
      .returning()

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "account",
      summary: "Changed password",
      ipAddress: req.ip,
    })

    res.json({ data: row ? serializeCurrentUser(row) : null })
  }
)

/** Persists an avatar that the client already uploaded to Cloudflare Images. */
meRouter.put(
  "/avatar",
  validate({
    body: z
      .object({ imageId: z.string().trim().min(1).max(120).nullable() })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const { imageId } = req.body as { imageId: string | null }

    // The client controls this value, so confirm the image really exists in
    // our Cloudflare account before storing a reference to it.
    if (imageId && !(await imageExists(imageId))) {
      throw new BadRequestError("That image was not found or was never uploaded")
    }

    const [row] = await db
      .update(userTable)
      .set({ avatarImageId: imageId, updatedAt: new Date() })
      .where(eq(userTable.id, user.id))
      .returning()

    if (!row) {
      throw new NotFoundError("User")
    }

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "account",
      summary: imageId ? "Updated avatar" : "Removed avatar",
      ipAddress: req.ip,
    })

    res.json({ data: serializeCurrentUser(row) })
  }
)

meRouter.get("/activity", async (req, res) => {
  const { user } = getAuth(req)

  const rows = await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.userId, user.id))
    .orderBy(desc(activityLog.createdAt))
    .limit(100)

  res.json({ data: rows.map((row) => serializeActivity(row)) })
})

meRouter.post("/logout", async (req, res) => {
  const signedOut = await auth.api.signOut({
    headers: fromNodeHeaders(req.headers),
    returnHeaders: true,
  })

  appendAuthCookies(res, signedOut.headers)
  res.json({ data: { ok: true } })
})
