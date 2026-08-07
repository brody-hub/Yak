import { Router } from "express"

import { NotFoundError } from "../lib/errors.js"
import {
  createSignedReadUrl,
  isManagedObjectKey,
  r2Configured,
} from "../services/r2.js"

/**
 * Public media redirect. Object keys are unguessable UUIDs; the handler only
 * serves keys that match our minting pattern, then 302s to a short-lived R2
 * signed GET. No session cookie required so `<img src>` works cross-origin.
 */
export const mediaRouter: Router = Router()

mediaRouter.get("/{*key}", async (req, res) => {
  if (!r2Configured()) {
    throw new NotFoundError("Media")
  }

  const raw = req.params.key
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : []
  const key = segments.map((part) => decodeURIComponent(part)).join("/")

  if (!key || !isManagedObjectKey(key)) {
    throw new NotFoundError("Media")
  }

  const url = await createSignedReadUrl(key)
  res.redirect(302, url)
})
