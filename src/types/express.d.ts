import type { ApiKeyContext, AuthContext } from "../auth/context.js"

declare global {
  namespace Express {
    interface Request {
      /** Present once requireAuth has run against a valid session cookie. */
      auth?: AuthContext
      /** Present once requireApiKey has run against a valid API key. */
      apiKey?: ApiKeyContext
      /** Correlation id echoed back on the response and in every log line. */
      id: string
    }
  }
}

export {}
