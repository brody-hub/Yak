import type { Response } from "express"

/**
 * Better Auth mutates session cookies through response headers. When we call
 * `auth.api.*` from our own Express handlers those headers are discarded
 * unless we ask for them (`returnHeaders: true`) and copy them onto `res`.
 *
 * Missing this step after `changePassword({ revokeOtherSessions: true })`
 * leaves the browser holding a cookie for a session that was just deleted.
 */
export function appendAuthCookies(res: Response, headers: Headers): void {
  const cookies =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : []

  if (cookies.length > 0) {
    for (const cookie of cookies) {
      res.append("Set-Cookie", cookie)
    }
    return
  }

  const single = headers.get("set-cookie")
  if (single) {
    res.append("Set-Cookie", single)
  }
}
