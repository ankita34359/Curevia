import { describe, it, expect } from 'vitest'
import { formatIst, istToUtcIso, istDate, istTime, addDays, weekdayOfDate } from '../server/lib/time.js'

describe('IST helpers', () => {
  it('formats UTC as India time', () => {
    expect(formatIst('2026-10-24T05:00:00.000Z')).toBe('24 Oct 2026, 10:30 AM')
    expect(formatIst('2026-10-24T18:29:00.000Z')).toBe('24 Oct 2026, 11:59 PM')
    expect(formatIst('2026-10-24T18:30:00.000Z')).toBe('25 Oct 2026, 12:00 AM')
  })
  it('converts IST clock times to UTC and back', () => {
    const utc = istToUtcIso('2026-10-24', '10:30')
    expect(utc).toBe('2026-10-24T05:00:00.000Z')
    expect(istDate(utc)).toBe('2026-10-24')
    expect(istTime(utc)).toBe('10:30')
  })
  it('does date maths on calendar days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(weekdayOfDate('2026-10-24')).toBe(6)
  })
})
