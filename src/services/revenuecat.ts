import { eq } from "drizzle-orm"

import { db } from "../db/index.js"
import { providerIntegrations } from "../db/schema.js"
import { decryptSecret } from "../lib/crypto.js"
import {
  BadRequestError,
  RateLimitError,
  ServiceUnavailableError,
} from "../lib/errors.js"
import { logger } from "../logger.js"

const API_BASE = "https://api.revenuecat.com/v2"
const REQUEST_TIMEOUT_MS = 10_000

/**
 * RevenueCat allows 25 requests per minute against the whole Charts & Metrics
 * domain, which a dashboard with a handful of trend tiles open in a few
 * browsers exceeds quickly. Responses are cached in process: the overview for
 * a minute, and chart series for five, since RevenueCat itself only recomputes
 * charts every few minutes.
 *
 * Every call here is a read. Nothing in this module ever writes to RevenueCat.
 */
const OVERVIEW_CACHE_TTL_MS = 60_000
const CHART_CACHE_TTL_MS = 5 * 60_000
/** A failed chart read is remembered briefly so a broken tile does not retry on every render. */
const CHART_FAILURE_TTL_MS = 60_000

type CacheEntry = { expiresAt: number; value: unknown }

const cache = new Map<string, CacheEntry>()

function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>
): Promise<T> {
  const hit = cache.get(key)

  if (hit && hit.expiresAt > Date.now()) {
    return Promise.resolve(hit.value as T)
  }

  return load().then((value) => {
    cache.set(key, { expiresAt: Date.now() + ttlMs, value })
    return value
  })
}

/** Dropped whenever the stored credential changes so stale data cannot leak. */
export function clearRevenueCatCache() {
  cache.clear()
}

/* -------------------------------------------------------------------------- */
/* Stored credential                                                          */
/* -------------------------------------------------------------------------- */

export type RevenueCatCredential = {
  apiKey: string
  projectId: string
}

/**
 * Reads and decrypts the stored key. Returns null when RevenueCat has not been
 * connected, which callers treat as "no data available" rather than an error.
 */
export async function loadRevenueCatCredential(): Promise<RevenueCatCredential | null> {
  const [row] = await db
    .select()
    .from(providerIntegrations)
    .where(eq(providerIntegrations.provider, "revenuecat"))
    .limit(1)

  if (!row?.externalId) {
    return null
  }

  try {
    return { apiKey: decryptSecret(row.apiKeyEncrypted), projectId: row.externalId }
  } catch (error) {
    // A rotated ENCRYPTION_KEY makes the ciphertext unreadable. Surface it as
    // disconnected so the operator is prompted to re-enter the key.
    logger.error({ err: error }, "Could not decrypt the RevenueCat API key")
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

/** A non-2xx reply from RevenueCat, with the status kept so callers can tell a permission problem from a bad request. */
class RevenueCatHttpError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`RevenueCat responded ${status}`)
    this.name = "RevenueCatHttpError"
    this.status = status
    this.body = body
  }
}

/** A network failure or timeout before RevenueCat answered. */
class RevenueCatNetworkError extends Error {
  constructor(cause: unknown) {
    super("Could not reach RevenueCat", { cause })
    this.name = "RevenueCatNetworkError"
  }
}

/** GET only. This client has no way to send a body or a mutating verb. */
async function rawRequest<T>(
  apiKey: string,
  path: string,
  query?: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`)

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }

  let response: Response

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    logger.warn({ err: error, path }, "RevenueCat request failed")
    throw new RevenueCatNetworkError(error)
  }

  if (!response.ok) {
    // The body is kept short: it is only ever logged, never returned.
    const body = (await response.text().catch(() => "")).slice(0, 500)
    throw new RevenueCatHttpError(response.status, body)
  }

  return (await response.json()) as T
}

/** Same request, with failures turned into the panel's error envelope. */
async function revenueCatRequest<T>(
  apiKey: string,
  path: string,
  query?: Record<string, string | number | undefined>
): Promise<T> {
  try {
    return await rawRequest<T>(apiKey, path, query)
  } catch (error) {
    if (error instanceof RevenueCatNetworkError) {
      throw new ServiceUnavailableError("Could not reach RevenueCat")
    }

    if (!(error instanceof RevenueCatHttpError)) {
      throw error
    }

    if (error.status === 401 || error.status === 403) {
      throw new BadRequestError(
        "RevenueCat rejected the API key. Use a secret v2 key with every Read permission enabled, and no Write permissions."
      )
    }

    if (error.status === 404) {
      throw new BadRequestError(
        "RevenueCat could not find that project. Reconnect the integration to pick it up again."
      )
    }

    if (error.status === 429) {
      throw new RateLimitError(
        "RevenueCat is rate limiting this project. Try again in a minute."
      )
    }

    logger.warn(
      { status: error.status, path, body: error.body },
      "Unexpected RevenueCat response"
    )
    throw new ServiceUnavailableError("RevenueCat returned an unexpected error")
  }
}

/* -------------------------------------------------------------------------- */
/* Key validation                                                             */
/* -------------------------------------------------------------------------- */

export type RevenueCatProject = { id: string; name: string }

type ProjectListResponse = {
  items?: { id?: string; name?: string }[]
}

/**
 * Non secret fragment shown in the UI in place of the key.
 *
 * RevenueCat keys are long and prefixed (`sk_…`), so keeping the prefix plus the
 * last four characters is enough for an operator to tell two keys apart without
 * exposing anything usable.
 */
export function apiKeyHint(value: string): string {
  const trimmed = value.trim()

  if (trimmed.length <= 8) {
    return "•".repeat(8)
  }

  return `${trimmed.slice(0, 5)}…${trimmed.slice(-4)}`
}

/**
 * Confirms a key works and resolves which project it should read.
 *
 * Listing projects doubles as the credential check: it is the cheapest v2
 * endpoint a metrics-capable key can reach, and its result is what we need to
 * address every later request.
 */
export async function resolveProject(
  apiKey: string,
  requestedProjectId?: string
): Promise<RevenueCatProject> {
  const projects = await listProjects(apiKey)

  if (projects.length === 0) {
    throw new BadRequestError(
      "That key is valid but has no projects. Create a project in RevenueCat first."
    )
  }

  if (requestedProjectId) {
    const match = projects.find((project) => project.id === requestedProjectId)

    if (!match) {
      throw new BadRequestError(
        `This key cannot read project ${requestedProjectId}`
      )
    }

    return match
  }

  return projects[0] as RevenueCatProject
}

export async function listProjects(apiKey: string): Promise<RevenueCatProject[]> {
  const response = await revenueCatRequest<ProjectListResponse>(
    apiKey,
    "/projects",
    { limit: 20 }
  )

  return (response.items ?? []).flatMap((item) =>
    item.id ? [{ id: item.id, name: item.name ?? item.id }] : []
  )
}

/* -------------------------------------------------------------------------- */
/* Overview metrics                                                           */
/* -------------------------------------------------------------------------- */

type OverviewResponse = {
  metrics?: {
    id?: string
    name?: string
    description?: string
    unit?: string
    period?: string
    value?: number | null
    last_updated_at_iso8601?: string | null
  }[]
  currency?: string
}

export type RevenueCatMetric = {
  id: string
  name: string
  description: string | null
  /** `$` for money, `#` for counts, `%` for rates. */
  unit: string
  /** ISO 8601 duration the value covers, e.g. `P28D`. `P0D` means "right now". */
  period: string
  value: number | null
  lastUpdatedAt: string | null
}

export type RevenueCatOverview = {
  currency: string
  metrics: RevenueCatMetric[]
  fetchedAt: string
}

/**
 * The one call that backs every KPI tile: RevenueCat returns its whole overview
 * panel in a single response, so individual chart endpoints are never needed
 * just to fill in a stat card.
 */
export async function fetchOverview(
  credential: RevenueCatCredential
): Promise<RevenueCatOverview> {
  return cached(`overview:${credential.projectId}`, OVERVIEW_CACHE_TTL_MS, async () => {
    const response = await revenueCatRequest<OverviewResponse>(
      credential.apiKey,
      `/projects/${encodeURIComponent(credential.projectId)}/metrics/overview`
    )

    return {
      currency: response.currency ?? "USD",
      metrics: (response.metrics ?? []).flatMap((metric) =>
        metric.id
          ? [
              {
                id: metric.id,
                name: metric.name ?? metric.id,
                description: metric.description ?? null,
                unit: metric.unit ?? "#",
                period: metric.period ?? "P0D",
                value: typeof metric.value === "number" ? metric.value : null,
                lastUpdatedAt: metric.last_updated_at_iso8601 ?? null,
              },
            ]
          : []
      ),
      fetchedAt: new Date().toISOString(),
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Charts (time series)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Chart ids the panel uses. They are stored in saved dashboard layouts, so
 * they stay stable and are mapped to RevenueCat's own chart names below.
 */
export const REVENUECAT_CHARTS = [
  "revenue",
  "mrr",
  "active_subscriptions",
  "new_customers",
  "active_trials",
  "trials_conversion",
  "churned_subscriptions",
] as const

export type RevenueCatChartName = (typeof REVENUECAT_CHARTS)[number]

/**
 * RevenueCat's chart identifiers, as listed by the v2 Charts & Metrics
 * reference. Only `revenue` and `mrr` share a name with the panel's id.
 */
const REVENUECAT_CHART_IDS: Record<RevenueCatChartName, string> = {
  revenue: "revenue",
  mrr: "mrr",
  active_subscriptions: "actives",
  new_customers: "customers_new",
  active_trials: "trials",
  trials_conversion: "trial_conversion_rate",
  churned_subscriptions: "churn",
}

export function isRevenueCatChart(value: string): value is RevenueCatChartName {
  return (REVENUECAT_CHARTS as readonly string[]).includes(value)
}

export type RevenueCatResolution = "day" | "week" | "month"

export type RevenueCatSeries = {
  chart: RevenueCatChartName
  resolution: RevenueCatResolution
  points: { date: string; value: number }[]
}

/**
 * Why a chart could not be read. Reported to the panel so a tile can say
 * something true instead of guessing.
 *
 * - `permission`: the key works for the overview but lacks
 *   `charts_metrics:charts:read`.
 * - `rate_limited`: RevenueCat's 25 requests per minute budget is spent.
 * - `unavailable`: RevenueCat answered, but not with a series we could read.
 * - `unreachable`: network failure or timeout.
 */
export type RevenueCatChartFailure = {
  reason: "permission" | "rate_limited" | "unavailable" | "unreachable"
  message: string
}

export type RevenueCatChartResult =
  | { ok: true; series: RevenueCatSeries }
  | { ok: false; failure: RevenueCatChartFailure }

/**
 * Chart responses carry several measures per period (for example revenue plus
 * a transaction count). Measure 0 is the headline series on every chart.
 */
const PRIMARY_MEASURE = 0

type ChartPoint = {
  cohort?: number | string
  period?: string
  date?: string
  measure?: number
  value?: number | string | null
  incomplete?: boolean
}

type ChartResponse = {
  object?: string
  resolution?: string
  /**
   * Documented as an array of arrays; observed as a flat array of points.
   * Both shapes are accepted, plus `data` in case the field is renamed.
   */
  values?: unknown
  data?: unknown
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function pointDate(raw: unknown): string | null {
  // Unix seconds (observed) or milliseconds, just in case.
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000
    return formatDate(new Date(ms))
  }

  if (typeof raw === "string" && raw.length >= 10) {
    // Either a plain date or a full timestamp; both start with YYYY-MM-DD.
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null
  }

  return null
}

function pointValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null
  }

  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Flattens whatever RevenueCat put under `values` into date/value pairs for the
 * primary measure, summing duplicates so a segmented response still charts as
 * one line.
 */
function parseChartPoints(response: ChartResponse): { date: string; value: number }[] {
  const raw = response.values ?? response.data

  if (!Array.isArray(raw)) {
    return []
  }

  // Nested arrays are one series per segment; flat arrays are one series.
  const entries: unknown[] = raw.flatMap((entry) =>
    Array.isArray(entry) && entry.some((item) => typeof item === "object")
      ? entry
      : [entry]
  )

  const totals = new Map<string, number>()

  for (const entry of entries) {
    let date: string | null = null
    let value: number | null = null

    if (Array.isArray(entry)) {
      // Tuple form: [period, value].
      date = pointDate(entry[0])
      value = pointValue(entry[1])
    } else if (entry && typeof entry === "object") {
      const point = entry as ChartPoint

      if (point.measure !== undefined && point.measure !== PRIMARY_MEASURE) {
        continue
      }

      date = pointDate(point.cohort ?? point.period ?? point.date)
      value = pointValue(point.value)
    }

    if (date === null || value === null) {
      continue
    }

    totals.set(date, (totals.get(date) ?? 0) + value)
  }

  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, value]) => ({ date, value }))
}

/**
 * Time series for one RevenueCat chart.
 *
 * Reads `GET /projects/{id}/charts/{chart}` with `start_date`, `end_date`
 * (YYYY-MM-DD) and `resolution`, which is the documented contract. Failures are
 * returned rather than thrown so one broken tile never takes down a dashboard,
 * but each failure carries its real cause: a permission gap, a rate limit, an
 * unreadable reply, or a network problem.
 */
export async function fetchChart(
  credential: RevenueCatCredential,
  chart: RevenueCatChartName,
  days: number
): Promise<RevenueCatChartResult> {
  const resolution: RevenueCatResolution =
    days > 90 ? "month" : days > 31 ? "week" : "day"
  const key = `chart:${credential.projectId}:${chart}:${days}`
  const hit = cache.get(key)

  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as RevenueCatChartResult
  }

  const result = await loadChart(credential, chart, days, resolution)

  cache.set(key, {
    value: result,
    expiresAt: Date.now() + (result.ok ? CHART_CACHE_TTL_MS : CHART_FAILURE_TTL_MS),
  })

  return result
}

async function loadChart(
  credential: RevenueCatCredential,
  chart: RevenueCatChartName,
  days: number,
  resolution: RevenueCatResolution
): Promise<RevenueCatChartResult> {
  const end = new Date()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  const remoteChart = REVENUECAT_CHART_IDS[chart]
  const path = `/projects/${encodeURIComponent(credential.projectId)}/charts/${remoteChart}`

  let response: ChartResponse

  try {
    response = await rawRequest<ChartResponse>(credential.apiKey, path, {
      resolution,
      start_date: formatDate(start),
      end_date: formatDate(end),
    })
  } catch (error) {
    return { ok: false, failure: describeChartError(error, chart) }
  }

  const points = parseChartPoints(response)

  if (points.length === 0) {
    // Either genuinely empty or a shape we do not understand. The top level
    // keys are logged so the difference is visible in production logs.
    logger.info(
      {
        chart: remoteChart,
        resolution,
        keys: Object.keys(response ?? {}),
        valuesType: Array.isArray(response?.values)
          ? `array(${(response.values as unknown[]).length})`
          : typeof response?.values,
      },
      "RevenueCat chart returned no readable points"
    )
  }

  return { ok: true, series: { chart, resolution, points } }
}

function describeChartError(
  error: unknown,
  chart: RevenueCatChartName
): RevenueCatChartFailure {
  if (error instanceof RevenueCatNetworkError) {
    return { reason: "unreachable", message: "Could not reach RevenueCat." }
  }

  if (error instanceof RevenueCatHttpError) {
    logger.warn(
      { status: error.status, chart, body: error.body },
      "RevenueCat chart request failed"
    )

    if (error.status === 401 || error.status === 403) {
      return {
        reason: "permission",
        message:
          "The RevenueCat key cannot read charts. Grant the Charts & Metrics read permission (charts_metrics:charts:read) to the key in RevenueCat, then reconnect it in Settings → Integrations.",
      }
    }

    if (error.status === 429) {
      return {
        reason: "rate_limited",
        message:
          "RevenueCat is rate limiting chart requests. This tile will retry in a minute.",
      }
    }

    return {
      reason: "unavailable",
      message: `RevenueCat did not return this chart (HTTP ${error.status}).`,
    }
  }

  logger.warn({ err: error, chart }, "RevenueCat chart read failed")

  return {
    reason: "unavailable",
    message: "RevenueCat did not return this chart.",
  }
}
