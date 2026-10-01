import rateLimit, { ipKeyGenerator } from "express-rate-limit"
import type { Request, RequestHandler, Response } from "express"

import { env } from "../env.js"
import { recordApiKeyFailure } from "../services/api-key-usage.js"

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

/** Notes the throttled request against the key before answering 429. */
function ingestLimitHandler(message: string) {
  return (
    req: Request,
    res: Response,
    _next: Parameters<RequestHandler>[2],
    options: { statusCode: number; message: unknown }
  ) => {
    if (req.apiKey) {
      recordApiKeyFailure(req.apiKey.id, req, {
        status: options.statusCode,
        code: "rate_limited",
        detail: message,
      })
    }

    res.status(options.statusCode).json(options.message)
  }
}

/**
 * Ingest is keyed per API key rather than per IP, so one noisy integration
 * cannot starve another and a shared NAT does not throttle a legitimate app.
 *
 * The ceilings are requests per minute and come from the environment, so a
 * deployment serving a busier app can raise them without a code change.
 */
export const ingestLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.INGEST_RATE_LIMIT_PER_MINUTE,
  keyGenerator: (req: Request) => req.apiKey?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Ingest rate limit exceeded"),
  handler: ingestLimitHandler("Ingest rate limit exceeded"),
})

/** Event batches are larger, so they get a smaller request budget. */
export const eventIngestLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.EVENT_INGEST_RATE_LIMIT_PER_MINUTE,
  keyGenerator: (req: Request) => req.apiKey?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Event ingest rate limit exceeded"),
  handler: ingestLimitHandler("Event ingest rate limit exceeded"),
})

/** Cloudflare direct-upload URLs cost an upstream API call each. */
export const uploadLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req: Request) => req.auth?.user.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Too many upload requests"),
})
