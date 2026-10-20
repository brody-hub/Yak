import { env } from "../../env.js"
import { logger } from "../../logger.js"

/**
 * Low level access to Sideshift's Platform API.
 *
 * Only the read-only `analytics:read` scope is ever requested, and nothing in
 * this module writes to Sideshift apart from the OAuth endpoints themselves
 * (registering Yak as a client, exchanging and revoking tokens).
 */

export const SIDESHIFT_ISSUER = env.SIDESHIFT_URL
export const SIDESHIFT_API = `${SIDESHIFT_ISSUER}/api/oauth/v1`
/** RFC 8707 resource indicator. Tokens are audience-bound to it. */
export const SIDESHIFT_RESOURCE = SIDESHIFT_API
export const SIDESHIFT_SCOPE = "analytics:read"

const REQUEST_TIMEOUT_MS = 20_000
/** Transient failures are retried this many times before giving up. */
const MAX_RETRIES = 2
const RETRY_DELAYS_MS = [1_000, 4_000]
/** A 429 asking for a longer wait than this ends the sync instead of blocking it. */
const MAX_RETRY_AFTER_SECONDS = 30

/**
 * A failed Sideshift call. `code` is Sideshift's own error code
 * (`subscription_required`, `insufficient_scope`, `invalid_grant`, ...), and
 * `requestId` is what their support asks for.
 */
export class SideshiftError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null = null
  ) {
    super(message)
    this.name = "SideshiftError"
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export type QueryValue = string | number | string[] | undefined | null

export function buildUrl(path: string, query?: Record<string, QueryValue>) {
  const url = new URL(`${SIDESHIFT_API}${path}`)

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") {
      continue
    }

    // Filters such as `programId` are repeated rather than comma joined.
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, String(item))
    }
  }

  return url.toString()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Reads either error shape Sideshift uses: the resource envelope
 * `{ error: { code, message, requestId } }` or the OAuth one
 * `{ error, error_description }`.
 */
async function toSideshiftError(response: Response): Promise<SideshiftError> {
  const body = (await response.json().catch(() => null)) as
    | {
        error?:
          | string
          | { code?: string; message?: string; requestId?: string }
        error_description?: string
      }
    | null

  const headerRequestId = response.headers.get("x-request-id")

  if (body && typeof body.error === "object" && body.error) {
    return new SideshiftError(
      response.status,
      body.error.code ?? "unknown_error",
      body.error.message ?? `Sideshift returned ${response.status}`,
      body.error.requestId ?? headerRequestId
    )
  }

  if (body && typeof body.error === "string") {
    return new SideshiftError(
      response.status,
      body.error,
      body.error_description ?? body.error,
      headerRequestId
    )
  }

  return new SideshiftError(
    response.status,
    response.status >= 500 ? "upstream_error" : "unknown_error",
    `Sideshift returned ${response.status}`,
    headerRequestId
  )
}

function isTransient(error: SideshiftError) {
  return (
    error.status === 0 ||
    error.status >= 500 ||
    error.code === "upstream_error"
  )
}

/**
 * Performs one Sideshift request, retrying network failures and 5xx responses
 * with backoff and honouring a short `Retry-After` on 429. Anything else is
 * thrown as a `SideshiftError` for the caller to interpret.
 *
 * `retry: false` is for requests that must never be sent twice. A refresh
 * token is single use, so replaying a refresh whose response was lost would
 * trip Sideshift's reuse detection and revoke the whole connection.
 */
export async function sideshiftRequest(
  url: string,
  init: RequestInit,
  { retry = true }: { retry?: boolean } = {}
): Promise<Response> {
  const maxRetries = retry ? MAX_RETRIES : 0

  for (let attempt = 0; ; attempt += 1) {
    let response: Response

    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(RETRY_DELAYS_MS[attempt] ?? 4_000)
        continue
      }

      throw new SideshiftError(
        0,
        "network_error",
        error instanceof Error && error.name === "TimeoutError"
          ? "Sideshift did not respond in time"
          : "Could not reach Sideshift"
      )
    }

    if (response.ok) {
      return response
    }

    const error = await toSideshiftError(response)

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "5")

      if (Number.isFinite(retryAfter) && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
        logger.info(
          { retryAfter, requestId: error.requestId },
          "Sideshift rate limited, waiting"
        )
        await sleep(Math.max(retryAfter, 1) * 1_000)
        continue
      }
    }

    if (isTransient(error) && attempt < maxRetries) {
      await sleep(RETRY_DELAYS_MS[attempt] ?? 4_000)
      continue
    }

    logger.warn(
      {
        status: error.status,
        code: error.code,
        requestId: error.requestId,
        path: new URL(url).pathname,
      },
      "Sideshift request failed"
    )

    throw error
  }
}

/** GET against the Platform API with a bearer token. */
export async function getResource(
  accessToken: string,
  path: string,
  query?: Record<string, QueryValue>,
  accept = "application/json"
): Promise<Response> {
  return sideshiftRequest(buildUrl(path, query), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: accept,
    },
  })
}
