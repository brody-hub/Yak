import { Router } from "express"
import { z } from "zod"

import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { createDirectUpload, imagesConfigured } from "../services/images.js"

export const uploadsRouter: Router = Router()

uploadsRouter.get("/status", (_req, res) => {
  res.json({ data: { imagesConfigured: imagesConfigured() } })
})

/**
 * Hands the browser a one-time Cloudflare upload URL.
 *
 * The file never touches this server, which keeps large multipart bodies off
 * the API and means no request size limit has to be relaxed.
 */
uploadsRouter.post(
  "/direct-upload",
  validate({
    body: z
      .object({ purpose: z.enum(["avatar", "branding"]) })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const { purpose } = req.body as { purpose: "avatar" | "branding" }

    const upload = await createDirectUpload({
      requestedByUserId: user.id,
      purpose,
    })

    res.json({ data: upload })
  }
)
