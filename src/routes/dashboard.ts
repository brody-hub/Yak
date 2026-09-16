import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { dashboardLayouts, type DashboardWidgetConfig } from "../db/schema.js"
import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"

export const dashboardRouter: Router = Router()

/**
 * Per user widget layout.
 *
 * Widget types and their option keys are defined on the client, so the server
 * stores the layout opaquely: it validates the shape and the size, and leaves
 * meaning to the panel. What a user is *allowed* to see is not enforced here —
 * each widget reads from an existing endpoint that already gates on its own
 * section permission, so a widget for a section a user lost access to simply
 * renders an error rather than leaking anything.
 */

const MAX_WIDGETS = 24
/** Columns on the panel's board. Widths and x positions are bounded by it. */
const GRID_COLS = 12
/** Generous ceiling so a corrupt client cannot store a mile-tall layout. */
const MAX_ROWS = 400

const layoutSchema = z
  .object({
    x: z.number().int().min(0).max(GRID_COLS - 1),
    y: z.number().int().min(0).max(MAX_ROWS),
    w: z.number().int().min(1).max(GRID_COLS),
    h: z.number().int().min(1).max(MAX_ROWS),
  })
  .refine((layout) => layout.x + layout.w <= GRID_COLS, {
    message: "Widget runs past the right edge of the board",
  })

const widgetSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.string().trim().min(1).max(64),
  options: z
    .record(
      z.string().max(40),
      z.union([z.string().max(120), z.number(), z.boolean()])
    )
    .default({}),
  layout: layoutSchema.optional(),
})

dashboardRouter.get("/layout", async (req, res) => {
  const { user } = getAuth(req)

  const [row] = await db
    .select()
    .from(dashboardLayouts)
    .where(eq(dashboardLayouts.userId, user.id))
    .limit(1)

  res.json({
    data: {
      // Null means "never configured", which the panel replaces with a default
      // layout built from the permissions the user actually holds. An empty
      // array means the user deliberately cleared their dashboard.
      widgets: row?.widgets ?? null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    },
  })
})

dashboardRouter.put(
  "/layout",
  validate({
    body: z
      .object({ widgets: z.array(widgetSchema).max(MAX_WIDGETS) })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const body = req.body as { widgets: DashboardWidgetConfig[] }

    const values = {
      userId: user.id,
      widgets: body.widgets,
      updatedAt: new Date(),
    }

    const [row] = await db
      .insert(dashboardLayouts)
      .values(values)
      .onConflictDoUpdate({ target: dashboardLayouts.userId, set: values })
      .returning()

    res.json({
      data: {
        widgets: row?.widgets ?? [],
        updatedAt: row?.updatedAt?.toISOString() ?? null,
      },
    })
  }
)
