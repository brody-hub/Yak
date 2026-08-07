import type { RequestHandler } from "express"
import type { ZodType } from "zod"

import { ValidationError } from "../lib/errors.js"

type Schemas = {
  body?: ZodType
  query?: ZodType
  params?: ZodType
}

/**
 * Parses and replaces `body`, `query`, and `params` with their validated
 * shapes. Unknown keys are stripped by the schemas themselves, so handlers
 * only ever see values the schema explicitly allows.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.params) {
        const result = schemas.params.safeParse(req.params)

        if (!result.success) {
          throw new ValidationError(
            formatIssues(result.error),
            "Invalid path parameters"
          )
        }

        Object.assign(req.params, result.data)
      }

      if (schemas.query) {
        const result = schemas.query.safeParse(req.query)

        if (!result.success) {
          throw new ValidationError(
            formatIssues(result.error),
            "Invalid query parameters"
          )
        }

        // Express 5 exposes `req.query` through a getter, so the parsed value
        // is stashed separately and read with `validatedQuery`.
        Object.defineProperty(req, "validatedQuery", {
          value: result.data,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      }

      if (schemas.body) {
        const result = schemas.body.safeParse(req.body)

        if (!result.success) {
          throw new ValidationError(formatIssues(result.error))
        }

        req.body = result.data
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}

function formatIssues(error: { issues: readonly unknown[] }) {
  return (error.issues as { path: (string | number)[]; message: string }[]).map(
    (issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
    })
  )
}

/** Reads the schema-parsed query produced by `validate({ query })`. */
export function validatedQuery<T>(req: unknown): T {
  return (req as { validatedQuery: T }).validatedQuery
}
