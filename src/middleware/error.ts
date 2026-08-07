import type { ErrorRequestHandler, RequestHandler } from "express"

import { AppError } from "../lib/errors.js"
import { logger } from "../logger.js"

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

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error({ err: error, requestId: req.id }, error.message)
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
