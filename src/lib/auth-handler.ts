import type { Request, RequestHandler } from "express"

import { auth } from "../auth/auth.js"
import { env } from "../env.js"

/**
 * The Better Auth endpoints the panel uses, as `METHOD /path`. Better Auth
 * exposes many more (update user, list sessions, change password, ...) that
 * know nothing about tenants or our own checks; none of them are reachable.
 */
const AUTH_ENDPOINTS = new Set([
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-out",
  "GET /api/auth/get-session",
  "POST /api/auth/request-password-reset",
  "POST /api/auth/reset-password",
])

/** Sign in and reset bodies are a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Headers that would let a client influence the URL Better Auth routes on, or
 * the IP its sign in rate limit counts against.
 */
const DROPPED_HEADERS = new Set([
  "host",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "content-length",
  "transfer-encoding",
  "connection",
])

class BodyTooLargeError extends Error {}

async function readBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length

    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError()
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

function notFound(res: Parameters<RequestHandler>[1]) {
  res.status(404).json({ error: { code: "not_found", message: "Not found" } })
}

/**
 * Hands allowlisted requests to Better Auth.
 *
 * Better Auth's own Node adapter rebuilds the URL from the client's Host and
 * X-Forwarded-Proto headers plus the raw path, then routes on the parsed
 * result. That lets a request that passed a path check elsewhere be steered to
 * any endpoint (`Host: x/api/auth/update-user?`), and dot segments or `%2e` in
 * the path are resolved the same way. So the Request is built here instead:
 * the path must exactly equal an allowlisted one, the origin is always
 * API_URL, and the query string is dropped.
 */
export const betterAuthHandler: RequestHandler = async (req, res, next) => {
  try {
    const [rawPath = ""] = req.originalUrl.split("?")
    const key = `${req.method} ${rawPath}`

    if (!AUTH_ENDPOINTS.has(key)) {
      notFound(res)
      return
    }

    const url = new URL(rawPath, env.API_URL)

    // The allowlist holds plain paths, so parsing changes nothing; checked
    // anyway so a future entry with odd characters fails closed.
    if (url.pathname !== rawPath || url.origin !== new URL(env.API_URL).origin) {
      notFound(res)
      return
    }

    const headers = new Headers()

    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROPPED_HEADERS.has(name.toLowerCase())) {
        continue
      }

      for (const item of Array.isArray(value) ? value : [value]) {
        headers.append(name, item)
      }
    }

    // `req.ip` is what Express resolved with `trust proxy` set to Railway's
    // one hop, so a client cannot pick its own address to dodge the sign in
    // limit (Better Auth would otherwise trust a forged X-Forwarded-For).
    if (req.ip) {
      headers.set("x-forwarded-for", req.ip)
    }

    const body = req.method === "GET" ? undefined : await readBody(req)

    const response = await auth.handler(
      new Request(url, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      })
    )

    res.status(response.status)

    response.headers.forEach((value, name) => {
      if (name.toLowerCase() !== "set-cookie") {
        res.setHeader(name, value)
      }
    })

    for (const cookie of response.headers.getSetCookie()) {
      res.append("Set-Cookie", cookie)
    }

    res.send(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      res
        .status(413)
        .json({ error: { code: "payload_too_large", message: "Request body too large" } })
      return
    }

    next(error)
  }
}
