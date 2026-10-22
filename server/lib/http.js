export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// Parses with a zod schema; the first problem becomes a friendly 400.
export function parse(schema, data) {
  const r = schema.safeParse(data)
  if (r.success) return r.data
  const issue = r.error.issues[0]
  const field = issue.path.length ? `${issue.path.join('.')}: ` : ''
  throw new HttpError(400, `${field}${issue.message}`)
}
