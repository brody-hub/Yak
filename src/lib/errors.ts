/**
 * Errors thrown anywhere in a request lifecycle. The error middleware turns
 * these into a stable JSON envelope; anything that is not an AppError is
 * reported as a generic 500 so internal details never reach the client.
 */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message)
    this.name = "AppError"
    this.status = status
    this.code = code
    this.details = details
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Invalid request", details?: unknown) {
    super(400, "bad_request", message, details)
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = "Validation failed") {
    super(422, "validation_error", message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource") {
    super(403, "forbidden", message)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(404, "not_found", `${resource} not found`)
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists") {
    super(409, "conflict", message)
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests") {
    super(429, "rate_limited", message)
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Upstream service unavailable") {
    super(503, "service_unavailable", message)
  }
}
