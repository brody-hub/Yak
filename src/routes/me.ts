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

const INLINE_AVATAR_MAX_CHARS = 350_000
const INLINE_AVATAR_PATTERN =
  /^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/

/**
 * Persists an avatar. Prefer a Cloudflare Images id when that integration is
 * configured; otherwise the panel may send a small compressed data URL which
 * we store on the Better Auth `image` column.
 */
meRouter.put(
  "/avatar",
  validate({
    body: z
      .object({
        imageId: z.string().trim().min(1).max(120).nullable().optional(),
        dataUrl: z.string().trim().min(1).max(INLINE_AVATAR_MAX_CHARS).nullable().optional(),
      })
      .strict()
      .refine(
        (body) =>
          Object.prototype.hasOwnProperty.call(body, "imageId") ||
          Object.prototype.hasOwnProperty.call(body, "dataUrl"),
        { message: "Provide imageId or dataUrl" }
      ),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const body = req.body as {
      imageId?: string | null
      dataUrl?: string | null
    }

    const patch: {
      avatarImageId?: string | null
      image?: string | null
      updatedAt: Date
    } = { updatedAt: new Date() }

    let summary = "Removed avatar"

    if (Object.prototype.hasOwnProperty.call(body, "dataUrl")) {
      const dataUrl = body.dataUrl ?? null

      if (dataUrl === null) {
        patch.image = null
        patch.avatarImageId = null
      } else {
        if (!INLINE_AVATAR_PATTERN.test(dataUrl)) {
          throw new BadRequestError(
            "Avatar must be a JPEG, PNG, WebP, or GIF data URL"
          )
        }

        patch.image = dataUrl
        // Prefer the inline asset over any previous Cloudflare reference.
        patch.avatarImageId = null
        summary = "Updated avatar"
      }
    } else {
      const imageId = body.imageId ?? null

      if (imageId && !(await imageExists(imageId))) {
        throw new BadRequestError(
          "That image was not found or was never uploaded"
        )
      }

      patch.avatarImageId = imageId
      patch.image = null
      summary = imageId ? "Updated avatar" : "Removed avatar"
    }

    const [row] = await db
      .update(userTable)
      .set(patch)
      .where(eq(userTable.id, user.id))
      .returning()

    if (!row) {
      throw new NotFoundError("User")
    }

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "account",
      summary,
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
