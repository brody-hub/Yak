import rateLimit, { ipKeyGenerator } from "express-rate-limit"
import type { Request } from "express"

import { env } from "../env.js"

const shared = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  // Local development would otherwise trip limits during hot reload loops.
  skip: () => env.isDevelopment,
}

function jsonLimitResponse(message: string) {
  return {
    error: { code: "rate_limited", message },
  }
}

/** Broad ceiling for authenticated panel traffic, keyed per session user. */
export const panelLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 300,
  keyGenerator: (req: Request) => req.auth?.user.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Too many requests, slow down"),
})

/**
 * Tighter ceiling on unauthenticated endpoints so credential stuffing and
 * password-reset enumeration are expensive.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 5 * 60_000,
  limit: 30,
  message: jsonLimitResponse("Too many authentication attempts, try again later"),
})

/**
 * Ingest is keyed per API key rather than per IP, so one noisy integration
 * cannot starve another and a shared NAT does not throttle a legitimate app.
 */
export const ingestLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 600,
  keyGenerator: (req: Request) => req.apiKey?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Ingest rate limit exceeded"),
})

/** Event batches are larger, so they get a smaller request budget. */
export const eventIngestLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 300,
  keyGenerator: (req: Request) => req.apiKey?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Event ingest rate limit exceeded"),
})

/** Cloudflare direct-upload URLs cost an upstream API call each. */
export const uploadLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req: Request) => req.auth?.user.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Too many upload requests"),
})
