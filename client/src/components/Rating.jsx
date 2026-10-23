// Star display: "★★★★☆". Used for an average (one decimal) and for single ratings.
export function Stars({ value, className = '' }) {
  const full = Math.round(value)
  return (
    <span className={`inline-flex text-amber-500 ${className}`} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= full ? '' : 'text-slate-300'}>★</span>)}
    </span>
  )
}

// "★ 4.5 (12)": a doctor's average rating and how many ratings it is based on. Nothing at all when there are none.
export function RatingBadge({ avg, count, className = '' }) {
  if (!count) return null
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${className}`} aria-label={`Rated ${avg} out of 5 from ${count} ${count === 1 ? 'rating' : 'ratings'}`} data-testid="rating-badge">
      <span className="text-amber-500" aria-hidden="true">★</span>
      <span className="font-semibold">{Number(avg).toFixed(1)}</span>
      <span className="text-ink-muted" aria-hidden="true">({count})</span>
    </span>
  )
}
