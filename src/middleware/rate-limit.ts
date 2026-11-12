import rateLimit, { ipKeyGenerator } from "express-rate-limit"
import type { Request, RequestHandler, Response } from "express"

import { env } from "../env.js"
import { recordApiKeyFailure } from "../services/api-key-usage.js"

const shared = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  // Only off when asked for explicitly (hot reload loops in development); a
  // deployment that forgets NODE_ENV must not lose its limits.
  skip: () => env.rateLimitDisabled,
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
  keyGenerator: (req: Request) =>
    req.auth?.user.id ?? ipKeyGenerator(req.ip ?? ""),
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
  message: jsonLimitResponse(
    "Too many authentication attempts, try again later"
  ),
})

/**
 * Each sign up creates an account and sends an email, so a few per hour from
 * one address is plenty for a person and little use to a script.
 */
export const signupLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60_000,
  limit: 5,
  message: jsonLimitResponse("Too many sign ups from here, try again later"),
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
      recordApiKeyFailure(req.apiKey, req, {
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
  keyGenerator: (req: Request) =>
    req.apiKey?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Ingest rate limit exceeded"),
  handler: ingestLimitHandler("Ingest rate limit exceeded"),
})

/** Event batches are larger, so they get a smaller request budget. */
export const eventIngestLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.EVENT_INGEST_RATE_LIMIT_PER_MINUTE,
  keyGenerator: (req: Request) =>
    req.apiKey?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Event ingest rate limit exceeded"),
  handler: ingestLimitHandler("Event ingest rate limit exceeded"),
})

/**
 * Counts only rejected requests, per IP, in front of API key authentication.
 * Valid keys are not slowed down by it; a flood of invalid keys is, so it
 * cannot drain the database pool one lookup at a time.
 */
export const ingestAuthLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 60,
  skipSuccessfulRequests: true,
  message: jsonLimitResponse("Too many rejected API key attempts"),
})

/** The same, for forged or stale session cookies against the panel. */
export const panelAuthLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 60,
  skipSuccessfulRequests: true,
  message: jsonLimitResponse("Too many rejected requests"),
})

/**
 * Changing a password proves the current one, so wrong guesses are limited
 * per user well below the general panel ceiling.
 */
export const passwordChangeLimiter = rateLimit({
  ...shared,
  windowMs: 10 * 60_000,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) =>
    req.auth?.user.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Too many password attempts, try again later"),
})

/** Cloudflare direct-upload URLs cost an upstream API call each. */
export const uploadLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req: Request) =>
    req.auth?.user.id ?? ipKeyGenerator(req.ip ?? ""),
  message: jsonLimitResponse("Too many upload requests"),
})
