import { Router } from "express"
import { z } from "zod"

import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import {
  createDirectUpload,
  isAllowedContentType,
  r2Configured,
} from "../services/r2.js"

export const uploadsRouter: Router = Router()

uploadsRouter.get("/status", (_req, res) => {
  const configured = r2Configured()
  res.json({
    data: {
      uploadsConfigured: configured,
      // Back-compat with the panel client
      imagesConfigured: configured,
    },
  })
})

/**
 * Hands the browser a short-lived R2 presigned PUT URL.
 *
 * The file never touches this server, which keeps large multipart bodies off
 * the API and means no request size limit has to be relaxed.
 */
uploadsRouter.post(
  "/direct-upload",
  validate({
    body: z
      .object({
        purpose: z.enum(["avatar", "branding"]),
        contentType: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .refine(isAllowedContentType, "Unsupported image type"),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const { purpose, contentType } = req.body as {
      purpose: "avatar" | "branding"
      contentType: string
    }

    const upload = await createDirectUpload({
      requestedByUserId: user.id,
      purpose,
      contentType,
    })

    res.json({ data: upload })
  }
)
