import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { addDaysStr, toTimeGroup } from '../lib/dates.js'
import { Alert, Skeleton } from './ui.jsx'

const GROUPS = [['Morning', '🌅'], ['Afternoon', '☀️'], ['Evening', '🌙']]

// Week date strip + time chips grouped Morning / Afternoon / Evening. Full and past slots are disabled.
export function SlotPicker({ doctorId, value, onChange }) {
  const [from, setFrom] = useState(undefined)
  const [week, setWeek] = useState(null)
  const [error, setError] = useState('')
  const [day, setDay] = useState(null)
  const picked = useRef(false)

  useEffect(() => {
    let live = true
    setWeek(null)
    api(`/public/doctors/${doctorId}/slots${from ? `?from=${from}` : ''}`)
      .then((w) => {
        if (!live) return
        setWeek(w)
        const withValue = value && w.days.find((d) => d.slots.some((s) => s.startUtc === value))
        const firstFree = w.days.find((d) => d.freeCount > 0)
        setDay((cur) => (withValue ? withValue.date : cur && w.days.some((d) => d.date === cur) && picked.current ? cur : (firstFree || w.days[0]).date))
      })
      .catch((e) => live && setError(e.message))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId, from])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!week) return <div className="space-y-4"><Skeleton className="h-20" /><Skeleton className="h-40" /></div>

  const current = week.days.find((d) => d.date === day) || week.days[0]
  const grouped = Object.fromEntries(GROUPS.map(([g]) => [g, current.slots.filter((s) => toTimeGroup(s.time) === g)]))

  return (
    <div>
      <div className="flex items-center gap-2">
        <button aria-label="Previous week" disabled={!week.canGoBack} onClick={() => { picked.current = false; setFrom(addDaysStr(week.from, -7)) }} className="rounded-xl border border-slate-200 p-2.5 transition hover:bg-brand-50 disabled:opacity-35">‹</button>
        <div className="grid flex-1 grid-cols-7 gap-2" role="group" aria-label="Choose a date">
          {week.days.map((d) => {
            const active = d.date === current.date
            return (
              <button key={d.date} aria-pressed={active} disabled={d.freeCount === 0} onClick={() => { picked.current = true; setDay(d.date) }}
                className={`rounded-xl border px-1 py-2.5 text-center transition duration-150 ${active ? 'border-brand-700 bg-brand-700 text-white shadow-md' : 'border-slate-200 bg-white hover:border-brand-400 hover:bg-brand-50'} disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 disabled:hover:border-slate-200`}>
                <span className="block text-xs font-medium">{d.weekday}</span>
                <span className="block text-lg font-bold leading-tight">{d.dayOfMonth}</span>
                <span className={`block text-[11px] ${active ? 'text-brand-100' : 'text-ink-muted'}`}>{d.freeCount ? `${d.freeCount} free` : 'none'}</span>
              </button>
            )
          })}
        </div>
        <button aria-label="Next week" disabled={!week.canGoForward} onClick={() => { picked.current = false; setFrom(addDaysStr(week.from, 7)) }} className="rounded-xl border border-slate-200 p-2.5 transition hover:bg-brand-50 disabled:opacity-35">›</button>
      </div>

      <div className="mt-6 space-y-5" key={current.date}>
        {current.freeCount === 0 && <p className="animate-fade-up rounded-xl bg-slate-100 px-4 py-6 text-center text-ink-soft">No free slots on this day. Try another date.</p>}
        {current.slots.length > 0 && GROUPS.map(([g, icon]) => grouped[g].length > 0 && (
          <div key={g} className="animate-fade-up">
            <h4 className="mb-2 text-sm font-semibold text-ink-soft"><span aria-hidden="true">{icon}</span> {g}</h4>
            <div className="flex flex-wrap gap-2">
              {grouped[g].map((s) => {
                const free = s.state === 'free'
                const selected = value === s.startUtc
                return (
                  <button key={s.startUtc} disabled={!free} aria-pressed={selected} title={free ? '' : s.state === 'booked' ? 'Already booked' : 'Time has passed'} onClick={() => onChange({ startUtc: s.startUtc, timeIst: s.timeIst, dateIst: `${current.dayOfMonth} ${current.month} ${current.date.slice(0, 4)}` })}
                    className={`min-w-[5.5rem] rounded-xl border px-3 py-2 text-sm font-semibold tabular-nums transition duration-150 ${selected ? 'scale-105 border-brand-700 bg-brand-700 text-white shadow-md' : free ? 'border-slate-300 bg-white hover:-translate-y-0.5 hover:border-brand-500 hover:bg-brand-50' : 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 line-through'}`}>
                    {s.timeIst}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
