import type { ErrorRequestHandler, RequestHandler } from "express"

import { AppError } from "../lib/errors.js"
import { logger } from "../logger.js"
import { recordApiKeyFailure } from "../services/api-key-usage.js"

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: "not_found",
      message: `No route matches ${req.method} ${req.path}`,
    },
  })
}

/** Postgres unique violation. */
const UNIQUE_VIOLATION = "23505"
/** Postgres foreign key violation. */
const FOREIGN_KEY_VIOLATION = "23503"

/**
 * Rejections that mean the integration is sending something wrong. A 404 is
 * left out: looking up a user or report that does not exist is normal use.
 */
const INTEGRATION_FAULTS = new Set([400, 409, 422])

function failureDetail(error: AppError): string {
  if (!Array.isArray(error.details)) {
    return error.message
  }

  // Field names and reasons only. The rejected values are never stored.
  return (error.details as { field?: string; message?: string }[])
    .slice(0, 3)
    .map((issue) => `${issue.field ?? "(root)"}: ${issue.message ?? "invalid"}`)
    .join("; ")
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error({ err: error, requestId: req.id }, error.message)
    }

    if (req.apiKey && INTEGRATION_FAULTS.has(error.status)) {
      recordApiKeyFailure(req.apiKey.id, req, {
        status: error.status,
        code: error.code,
        detail: failureDetail(error),
      })
    }

    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    })
    return
  }

  const pgCode = (error as { code?: string } | null)?.code

  if (pgCode === UNIQUE_VIOLATION) {
    res.status(409).json({
      error: {
        code: "conflict",
        message: "A record with these details already exists",
      },
    })
    return
  }

  if (pgCode === FOREIGN_KEY_VIOLATION) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: "Referenced record does not exist",
      },
    })
    return
  }

  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({
      error: { code: "bad_request", message: "Request body is not valid JSON" },
    })
    return
  }

  // Anything unrecognised is a bug. Log the detail, return nothing useful to
  // a potential attacker.
  logger.error(
    { err: error, requestId: req.id, path: req.path, method: req.method },
    "Unhandled error"
  )

  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Something went wrong on our end",
      requestId: req.id,
    },
  })
}
