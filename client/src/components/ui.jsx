import { forwardRef, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { initials } from '../lib/format.js'

export function Logo({ className = '', light = false }) {
  return (
    <span className={`inline-flex items-center gap-2 font-bold tracking-tight ${light ? 'text-white' : 'text-brand-800'} ${className}`}>
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill={light ? '#ffffff' : '#0f766e'} />
        <path d="M16 7v18M7 16h18" stroke={light ? '#0f766e' : '#fff'} strokeWidth="4.5" strokeLinecap="round" />
      </svg>
      <span className="text-xl">Curevia</span>
    </span>
  )
}

const BUTTON = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm',
  accent: 'bg-accent-400 text-ink hover:bg-accent-500 shadow-sm',
  secondary: 'bg-white text-brand-800 border border-slate-300 hover:bg-brand-50 hover:border-brand-300',
  ghost: 'text-ink-soft hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700'
}
export const Button = forwardRef(function Button({ variant = 'primary', size = 'md', loading = false, className = '', children, disabled, ...rest }, ref) {
  const pad = size === 'sm' ? 'px-3 py-1.5 text-sm' : size === 'lg' ? 'px-6 py-3 text-base' : 'px-4 py-2.5 text-sm'
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition duration-150 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-55 ${pad} ${BUTTON[variant]} ${className}`}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  )
})

export function Spinner({ className = '' }) {
  return <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} role="status" aria-label="Loading" />
}

export function Field({ label, hint, error, children }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">{label}</label>
      {children(id)}
      {hint && !error && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
      {error && <p className="mt-1 text-xs font-medium text-red-700" role="alert">{error}</p>}
    </div>
  )
}

export const inputClass =
  'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-slate-400 transition hover:border-slate-400 focus:border-brand-500'

export const Input = forwardRef(function Input({ className = '', ...rest }, ref) {
  return <input ref={ref} className={`${inputClass} ${className}`} {...rest} />
})

export function Alert({ tone = 'info', children, className = '' }) {
  const tones = {
    info: 'bg-sky-50 text-sky-900 border-sky-200',
    success: 'bg-brand-50 text-brand-900 border-brand-200',
    warn: 'bg-accent-50 text-amber-900 border-accent-200',
    error: 'bg-red-50 text-red-800 border-red-200'
  }
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]} ${className}`}>{children}</div>
}

const BADGE = {
  pending: 'bg-accent-100 text-amber-900',
  confirmed: 'bg-brand-100 text-brand-900',
  completed: 'bg-sky-100 text-sky-900',
  no_show: 'bg-slate-200 text-slate-700',
  cancelled_by_patient: 'bg-red-100 text-red-800',
  cancelled_by_doctor: 'bg-red-100 text-red-800',
  needs_rebooking: 'bg-orange-100 text-orange-900',
  rebooked: 'bg-slate-100 text-slate-700',
  expired: 'bg-slate-200 text-slate-700'
}
const STATUS_LABEL = {
  pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', no_show: 'No-show',
  cancelled_by_patient: 'Cancelled by patient', cancelled_by_doctor: 'Cancelled by doctor', needs_rebooking: 'Needs rebooking', rebooked: 'Rebooked', expired: 'Expired'
}
export const statusLabel = (s) => STATUS_LABEL[s] || s
export function StatusBadge({ status }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE[status] || 'bg-slate-100 text-slate-700'}`}>{statusLabel(status)}</span>
}

export const Skeleton = ({ className = 'h-4 w-full' }) => <div className={`skeleton ${className}`} aria-hidden="true" />

export function EmptyState({ title, children, icon = '🩺' }) {
  return (
    <div className="card animate-fade-up px-6 py-12 text-center">
      <div className="mb-3 text-4xl" aria-hidden="true">{icon}</div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {children && <p className="mx-auto mt-1 max-w-md text-ink-soft">{children}</p>}
    </div>
  )
}

export function Avatar({ name, photoUrl, size = 56 }) {
  const [failed, setFailed] = useState(false)
  const style = { width: size, height: size, fontSize: size * 0.36 }
  if (photoUrl && !failed) return <img src={photoUrl} alt="" style={style} className="shrink-0 rounded-full object-cover" onError={() => setFailed(true)} />
  return (
    <span style={style} aria-hidden="true" className="inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-sky-100 font-bold text-brand-800">
      {initials(name)}
    </span>
  )
}

// Every dialog in the app goes through this. It is rendered into document.body (a portal), never inside the card or page that
// opened it: a parent with a transform (the cards' fade-in animation), filter or overflow would otherwise trap a position:fixed
// child, clipping the dialog to the card and limiting the dark overlay to it.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose // always the latest handler, without re-running the effect below on every render
  useEffect(() => {
    const dialog = ref.current
    const prev = document.activeElement
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true }) // focus goes into the dialog (unless a field there already took it); no scrolling, so a tall dialog opens at its top
    // The page behind does not scroll while the dialog is open (the scrollbar's width is kept so nothing jumps).
    const { overflow, paddingRight } = document.body.style
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    document.body.style.overflow = 'hidden'
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return }
      if (e.key !== 'Tab' || !dialog) return
      // Tab stays inside the dialog.
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden], [aria-hidden="true"]'))
      if (!items.length) { e.preventDefault(); dialog.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === dialog)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
      else if (!dialog.contains(active)) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      document.body.style.paddingRight = paddingRight
      prev?.focus?.()
    }
  }, [])
  const closeOnBackdrop = (e) => e.target === e.currentTarget && closeRef.current()
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 backdrop-blur-sm" data-testid="modal-overlay" onMouseDown={closeOnBackdrop}>
      <div className="flex min-h-full items-center justify-center p-4" onMouseDown={closeOnBackdrop}>
        <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`card w-full animate-fade-up p-6 outline-none ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 className="text-lg font-bold">{title}</h2>
            <button type="button" onClick={() => closeRef.current()} aria-label="Close" className="rounded-lg p-1 text-ink-muted hover:bg-slate-100">✕</button>
          </div>
          {children}
        </div>
      </div>
    </div>,
    document.body
  )
}

export function Select({ className = '', children, ...rest }) {
  return <select className={`${inputClass} ${className}`} {...rest}>{children}</select>
}
export function Textarea({ className = '', ...rest }) {
  return <textarea className={`${inputClass} ${className}`} rows={3} {...rest} />
}

// Loads data on mount and whenever `deps` change. `reload()` refetches without the skeleton flash.
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: '', loading: true })
  const load = useCallback(async (quiet) => {
    if (!quiet) setState((s) => ({ ...s, loading: true }))
    try { setState({ data: await fn(), error: '', loading: false }) } catch (e) { setState({ data: null, error: e.message, loading: false }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { load() }, [load])
  return { ...state, reload: () => load(true) }
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-ink-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  )
}
