import { createHash, randomBytes } from "node:crypto"

import { env } from "../../env.js"
import {
  buildUrl,
  SIDESHIFT_API,
  SIDESHIFT_RESOURCE,
  SIDESHIFT_SCOPE,
  SideshiftError,
  sideshiftRequest,
} from "./client.js"

/**
 * Sideshift OAuth 2.1: dynamic client registration, the authorization-code
 * grant with PKCE (S256), refresh-token rotation, and revocation.
 *
 * Each Yak deployment has its own callback URL, so each one registers itself
 * as a confidential client the first time someone connects, rather than
 * sharing one client across customers.
 */

export function callbackUrl() {
  return `${env.API_URL}/api/sideshift/callback`
}

export type RegisteredClient = {
  clientId: string
  clientSecret: string
  registrationAccessToken: string | null
}

/** Registers this deployment with Sideshift (RFC 7591). */
export async function registerClient(
  redirectUri: string
): Promise<RegisteredClient> {
  const response = await sideshiftRequest(
    `${SIDESHIFT_API}/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: `${env.TENANT_NAME} dashboard`,
        client_uri: env.APP_URL,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SIDESHIFT_SCOPE,
        token_endpoint_auth_method: "client_secret_basic",
      }),
    },
    // Registration is not idempotent; a lost response would leave an orphan.
    { retry: false }
  )

  const body = (await response.json()) as {
    client_id?: string
    client_secret?: string
    registration_access_token?: string
  }

  if (!body.client_id || !body.client_secret) {
    throw new SideshiftError(
      response.status,
      "invalid_registration",
      "Sideshift did not return client credentials"
    )
  }

  return {
    clientId: body.client_id,
    clientSecret: body.client_secret,
    registrationAccessToken: body.registration_access_token ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/* Authorization request                                                       */
/* -------------------------------------------------------------------------- */

export type PendingAuthorization = {
  state: string
  verifier: string
  url: string
}

/** Builds the consent URL plus the secrets that must be kept until callback. */
export function createAuthorization(params: {
  clientId: string
  redirectUri: string
}): PendingAuthorization {
  const state = randomBytes(32).toString("base64url")
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")

  const url = buildUrl("/authorize", {
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: SIDESHIFT_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: SIDESHIFT_RESOURCE,
  })

  return { state, verifier, url }
}

/* -------------------------------------------------------------------------- */
/* Token endpoint                                                              */
/* -------------------------------------------------------------------------- */

export type TokenSet = {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scope: string | null
  /** Company the founder picked on the consent screen, when we can tell. */
  company: { id: string | null; name: string | null }
}

type ClientCredentials = { clientId: string; clientSecret: string }

function basicAuth({ clientId, clientSecret }: ClientCredentials) {
  // RFC 6749 §2.3.1: each part is form-encoded before joining.
  const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  return `Basic ${Buffer.from(pair).toString("base64")}`
}

const COMPANY_ID_CLAIMS = [
  "company_id",
  "companyId",
  "tenant_id",
  "tenantId",
  "tenant",
  "org_id",
  "tid",
]
const COMPANY_NAME_CLAIMS = [
  "company_name",
  "companyName",
  "tenant_name",
  "tenantName",
  "org_name",
]

function pickString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key]

    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }

  return null
}

/**
 * Works out which company the token is for, for display only.
 *
 * Reading the company profile needs `settings:read`, which this integration
 * deliberately does not ask for, so the id and name come from the token
 * response or the access token's claims when Sideshift includes them. The
 * JWT is decoded, not verified: nothing here is trusted for access decisions.
 */
function readCompany(
  body: Record<string, unknown>,
  accessToken: string
): TokenSet["company"] {
  let claims: Record<string, unknown> = {}

  try {
    const payload = accessToken.split(".")[1]

    if (payload) {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    }
  } catch {
    claims = {}
  }

  return {
    id: pickString(body, COMPANY_ID_CLAIMS) ?? pickString(claims, COMPANY_ID_CLAIMS),
    name:
      pickString(body, COMPANY_NAME_CLAIMS) ??
      pickString(claims, COMPANY_NAME_CLAIMS),
  }
}

async function tokenRequest(
  client: ClientCredentials,
  params: Record<string, string>
): Promise<TokenSet> {
  const response = await sideshiftRequest(
    `${SIDESHIFT_API}/token`,
    {
      method: "POST",
      headers: {
        Authorization: basicAuth(client),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        ...params,
        client_id: client.clientId,
        resource: SIDESHIFT_RESOURCE,
      }).toString(),
    },
    // Codes and refresh tokens are single use. Never replay them.
    { retry: false }
  )

  const body = (await response.json()) as Record<string, unknown>
  const accessToken = body.access_token
  const refreshToken = body.refresh_token
  const expiresIn = Number(body.expires_in ?? 3600)

  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new SideshiftError(
      response.status,
      "invalid_token_response",
      "Sideshift did not return both an access and a refresh token"
    )
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(
      Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1_000
    ),
    scope: typeof body.scope === "string" ? body.scope : null,
    company: readCompany(body, accessToken),
  }
}

export function exchangeCode(
  client: ClientCredentials,
  params: { code: string; verifier: string; redirectUri: string }
) {
  return tokenRequest(client, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
  })
}

export function refreshTokens(client: ClientCredentials, refreshToken: string) {
  return tokenRequest(client, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  })
}

/**
 * Revokes a refresh token, which revokes its whole token family on Sideshift's
 * side (RFC 7009). Sideshift answers 200 even for unknown tokens.
 */
export async function revokeRefreshToken(
  client: ClientCredentials,
  refreshToken: string
) {
  await sideshiftRequest(`${SIDESHIFT_API}/revoke`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(client),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: client.clientId,
    }).toString(),
  })
}
