// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from '../client/src/components/ui.jsx'
import { AppointmentCard } from '../client/src/pages/doctor/DoctorHome.jsx'

afterEach(cleanup)

// A card like the real ones: it has the fade-in animation class, which is what trapped the dialog in the browser.
function Card({ children }) {
  return <div className="card animate-fade-up p-5" data-testid="card" style={{ transform: 'matrix(1, 0, 0, 1, 0, 0)' }}>{children}</div>
}
function Opener({ onClose = () => {}, withField = false }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  return (
    <Card>
      <button onClick={() => setOpen(true)}>Open it</button>
      {open && (
        <Modal title="Test dialog" onClose={() => { onClose(); setOpen(false) }}>
          {withField ? <textarea aria-label="Note" value={text} onChange={(e) => setText(e.target.value)} /> : <p>Dialog text</p>}
          <button>First action</button>
          <button>Last action</button>
        </Modal>
      )}
    </Card>
  )
}
const open = () => fireEvent.click(screen.getByText('Open it'))
const dialog = () => screen.queryByRole('dialog')

describe('Modal renders through a portal, never inside the card that opened it', () => {
  it('the dialog and its dark overlay are direct children of document.body, outside the card', () => {
    render(<Opener />)
    open()
    const d = dialog()
    expect(d).toBeTruthy()
    expect(screen.getByTestId('card').contains(d)).toBe(false) // not inside the card with the transform
    const overlay = screen.getByTestId('modal-overlay')
    expect(overlay.parentElement).toBe(document.body)
    expect(overlay.contains(d)).toBe(true)
    expect(overlay.className).toMatch(/fixed inset-0/) // covers the whole screen
    expect(overlay.className).toMatch(/bg-ink\/50/) // dark
    expect(d.parentElement.className).toMatch(/items-center justify-center/) // centered
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.getAttribute('aria-label')).toBe('Test dialog')
  })

  it('the real lab report dialog opens outside its appointment card, with the same texts', () => {
    const a = { id: 7, status: 'completed', patientName: 'Asha Patient', age: 30, gender: 'female', reason: 'Fake', phone: '9000000000', timeIst: '10:05 AM', dateIst: '23 Oct 2026', startUtc: '2026-10-23T04:35:00.000Z', labReport: null }
    const { container } = render(<AppointmentCard a={a} onChanged={() => {}} onError={() => {}} />)
    fireEvent.click(screen.getByText('Mark lab report ready'))
    const d = dialog()
    expect(d).toBeTruthy()
    expect(container.contains(d)).toBe(false)
    expect(d.closest('.animate-fade-up') === d).toBe(true) // the only animated ancestor is the dialog itself
    expect(screen.getByText('Lab report ready for Asha Patient')).toBeTruthy()
    expect(screen.getByText('Note for the patient (optional)')).toBeTruthy()
    expect(screen.getByPlaceholderText('e.g. Collect from Lab counter, ground floor')).toBeTruthy()
    expect(screen.getByText('Not yet')).toBeTruthy()
    fireEvent.click(screen.getByText('Not yet'))
    expect(dialog()).toBeNull()
  })

  it('the cancel dialog of a pending appointment also opens outside the card', () => {
    const a = { id: 8, status: 'pending', patientName: 'Asha Patient', age: 30, gender: 'female', reason: 'Fake', phone: '9000000000', timeIst: '10:05 AM', dateIst: '24 Oct 2026', startUtc: '2026-10-24T04:35:00.000Z', labReport: null }
    const { container } = render(<AppointmentCard a={a} onChanged={() => {}} onError={() => {}} />)
    fireEvent.click(screen.getByText('Cancel…'))
    expect(dialog()).toBeTruthy()
    expect(container.contains(dialog())).toBe(false)
    expect(screen.getByText("Cancel Asha Patient's appointment")).toBeTruthy()
    expect(screen.getByText('Keep appointment')).toBeTruthy()
  })
})

describe('closing', () => {
  it('Esc closes it', () => {
    const onClose = vi.fn()
    render(<Opener onClose={onClose} />)
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('the X button closes it', () => {
    render(<Opener />)
    open()
    fireEvent.click(screen.getByLabelText('Close'))
    expect(dialog()).toBeNull()
  })
  it('clicking the dark area outside the dialog closes it; clicking inside does not', () => {
    render(<Opener />)
    open()
    fireEvent.mouseDown(screen.getByText('Dialog text'))
    expect(dialog()).toBeTruthy()
    fireEvent.mouseDown(screen.getByTestId('modal-overlay'))
    expect(dialog()).toBeNull()
    open()
    fireEvent.mouseDown(dialog().parentElement) // the centering area around the dialog
    expect(dialog()).toBeNull()
  })
})

describe('focus and scrolling', () => {
  it('focus moves into the dialog, Tab stays inside it (both directions), and focus returns to the button after closing', () => {
    render(<Opener />)
    const opener = screen.getByText('Open it')
    opener.focus()
    open()
    const d = dialog()
    expect(d.contains(document.activeElement)).toBe(true)
    const first = screen.getByLabelText('Close')
    const last = screen.getByText('Last action')
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first) // wrapped from the last to the first
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last) // and back
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })
  it('typing in a field does not pull focus away (the dialog does not re-grab it on every render)', () => {
    render(<Opener withField />)
    open()
    const field = screen.getByLabelText('Note')
    field.focus()
    fireEvent.change(field, { target: { value: 'Collect from Lab counter' } })
    fireEvent.change(field, { target: { value: 'Collect from Lab counter, ground floor' } })
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('Collect from Lab counter, ground floor')
  })
  it('the page behind cannot scroll while it is open, and can again afterwards', () => {
    document.body.style.overflow = ''
    render(<Opener />)
    open()
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.body.style.overflow).toBe('')
  })
})

describe('every dialog in the app goes through Modal', () => {
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  const sources = files(path.resolve(__dirname, '../client/src')).filter((f) => /\.jsx?$/.test(f))
  const read = (f) => fs.readFileSync(f, 'utf8')
  const rel = (f) => path.relative(path.resolve(__dirname, '../client/src'), f)

  it('no page builds its own overlay or dialog: fixed full-screen layers and role="dialog" exist only in components/ui.jsx', () => {
    const own = sources.filter((f) => /role="dialog"|fixed inset-0|createPortal/.test(read(f)) && rel(f) !== path.join('components', 'ui.jsx'))
    expect(own.map(rel)).toEqual([])
  })
  it('the one Modal uses a portal to document.body', () => {
    const ui = read(path.resolve(__dirname, '../client/src/components/ui.jsx'))
    expect(ui).toMatch(/createPortal\(/)
    expect(ui).toMatch(/document\.body\s*\)/)
  })
  it('the dialogs that exist today are all <Modal> users (so the fix covers them): lab report, cancel, patient cancel, deactivate, edit/add doctor, department, disconnect, availability', () => {
    const users = sources.filter((f) => /<Modal\b/.test(read(f))).map(rel).sort()
    expect(users).toEqual(['pages/admin/AdminDepartments.jsx', 'pages/admin/AdminDoctors.jsx', 'pages/admin/AdminIntegrations.jsx', 'pages/doctor/DoctorAvailability.jsx', 'pages/doctor/DoctorHome.jsx', 'pages/patient/My.jsx'].sort())
  })
})
