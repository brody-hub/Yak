import type { ApiKeyContext, AppContext, AuthContext } from "../auth/context.js"
import type { Scope } from "../db/scope.js"

declare global {
  namespace Express {
    interface Request {
      /** Present once requireAuth has run against a valid session cookie. */
      auth?: AuthContext
      /** Present once requireApiKey has run against a valid API key. */
      apiKey?: ApiKeyContext
      /** Present once requireApp has resolved the `:appId` in the path. */
      currentApp?: AppContext
      /** The database scope the request runs in, once one has been entered. */
      dbScope?: Scope
      /** Correlation id echoed back on the response and in every log line. */
      id: string
    }
  }
}

export {}
