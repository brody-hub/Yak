import { Router } from "express"
import { z } from "zod"

import { getAuth, getTenantId } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { ForbiddenError } from "../lib/errors.js"
import {
  createDirectUpload,
  isAllowedContentType,
  MAX_UPLOAD_BYTES,
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
 * the API and means no request size limit has to be relaxed. The exact size
 * is signed into the URL, so the browser can only store the bytes it said it
 * would.
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
        sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
      })
      .strict(),
  }),
  async (req, res) => {
    const auth = getAuth(req)
    const { purpose, contentType, sizeBytes } = req.body as {
      purpose: "avatar" | "branding"
      contentType: string
      sizeBytes: number
    }

    // Only someone who can set the logo may mint space for one.
    if (purpose === "branding" && !auth.permissions.includes("theme")) {
      throw new ForbiddenError("You do not have access to the theme section")
    }

    const upload = await createDirectUpload({
      tenantId: getTenantId(req),
      requestedByUserId: auth.user.id,
      purpose,
      contentType,
      sizeBytes,
    })

    res.json({ data: upload })
  }
)
