import { z } from "zod"

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export type Pagination = z.infer<typeof paginationSchema>

export type Paginated<T> = {
  data: T[]
  pagination: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
}

export function paginated<T>(
  data: T[],
  total: number,
  { limit, offset }: Pagination
): Paginated<T> {
  return {
    data,
    pagination: {
      limit,
      offset,
      total,
      hasMore: offset + data.length < total,
    },
  }
}
