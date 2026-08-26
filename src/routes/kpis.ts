import { Router } from "express"
import { z } from "zod"

import { validate, validatedQuery } from "../middleware/validate.js"
import {
  fetchChart,
  fetchOverview,
  loadRevenueCatCredential,
  REVENUECAT_CHARTS,
  type RevenueCatChartName,
  type RevenueCatMetric,
} from "../services/revenuecat.js"

export const kpisRouter: Router = Router()

/**
 * Subscription KPIs.
 *
 * Every response carries a `connected` flag rather than failing when RevenueCat
 * has not been set up. The panel renders an empty state in that case, which is
 * a normal condition for a fresh deployment rather than an error.
 */

type KpiSummary = {
  mrr: number | null
  /** Derived: RevenueCat reports MRR, and ARR is just twelve months of it. */
  arr: number | null
  revenue: number | null
  activeSubscriptions: number | null
  activeTrials: number | null
  newCustomers: number | null
  activeUsers: number | null
  /** MRR divided across paying subscriptions. Null unless both are known. */
  arpu: number | null
}

function metricValue(
  metrics: RevenueCatMetric[],
  id: string
): number | null {
  return metrics.find((metric) => metric.id === id)?.value ?? null
}

function buildSummary(metrics: RevenueCatMetric[]): KpiSummary {
  const mrr = metricValue(metrics, "mrr")
  const activeSubscriptions = metricValue(metrics, "active_subscriptions")

  return {
    mrr,
    arr: mrr === null ? null : mrr * 12,
    revenue: metricValue(metrics, "revenue"),
    activeSubscriptions,
    activeTrials: metricValue(metrics, "active_trials"),
    newCustomers: metricValue(metrics, "new_customers"),
    activeUsers: metricValue(metrics, "active_users"),
    arpu:
      mrr !== null && activeSubscriptions !== null && activeSubscriptions > 0
        ? mrr / activeSubscriptions
        : null,
  }
}

kpisRouter.get("/overview", async (_req, res) => {
  const credential = await loadRevenueCatCredential()

  if (!credential) {
    res.json({
      data: {
        connected: false,
        currency: "USD",
        fetchedAt: null,
        summary: buildSummary([]),
        metrics: [],
      },
    })
    return
  }

  const overview = await fetchOverview(credential)

  res.json({
    data: {
      connected: true,
      currency: overview.currency,
      fetchedAt: overview.fetchedAt,
      summary: buildSummary(overview.metrics),
      // The raw list is passed through as well so the KPIs page can show any
      // metric RevenueCat adds later without a server change.
      metrics: overview.metrics,
    },
  })
})

kpisRouter.get(
  "/trend",
  validate({
    query: z.object({
      chart: z.enum(REVENUECAT_CHARTS).default("revenue"),
      days: z.coerce.number().int().min(7).max(365).default(30),
    }),
  }),
  async (req, res) => {
    const { chart, days } = validatedQuery<{
      chart: RevenueCatChartName
      days: number
    }>(req)

    const credential = await loadRevenueCatCredential()

    if (!credential) {
      res.json({
        data: { connected: false, available: false, chart, points: [] },
      })
      return
    }

    const series = await fetchChart(credential, chart, days)

    res.json({
      data: {
        connected: true,
        // False when the project's plan does not expose chart data; the tile
        // then explains why it is empty instead of showing a flat line.
        available: series !== null,
        chart,
        resolution: series?.resolution ?? null,
        points: series?.points ?? [],
      },
    })
  }
)

/** Chart ids the trend endpoint accepts, for the tile configuration picker. */
kpisRouter.get("/charts", (_req, res) => {
  res.json({
    data: REVENUECAT_CHARTS.map((chart) => ({
      id: chart,
      label: chart
        .replace(/_/g, " ")
        .replace(/^./, (character) => character.toUpperCase()),
    })),
  })
})
