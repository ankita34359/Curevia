// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

const state = vi.hoisted(() => ({ user: null, api: null }))
vi.mock('../client/src/lib/auth.jsx', () => ({ useAuth: () => ({ user: state.user, logout: async () => {} }), AuthProvider: ({ children }) => children, homeFor: () => '/' }))
vi.mock('../client/src/lib/api.js', () => ({
  api: (...a) => state.api(...a),
  ApiError: class ApiError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body } }
}))

import { PatientLayout } from '../client/src/components/Layouts.jsx'
import Home from '../client/src/pages/patient/Home.jsx'
import Doctors from '../client/src/pages/patient/Doctors.jsx'
import BookWithAI from '../client/src/pages/patient/BookWithAI.jsx'
import Book from '../client/src/pages/patient/Book.jsx'
import { readAiReason } from '../client/src/lib/aiBooking.js'
import { ApiError } from '../client/src/lib/api.js'

const SLOT = '2026-10-23T03:30:00.000Z'
const option = (over = {}) => ({ doctorId: 2, doctorName: 'Dr Heart One', department: 'Cardiology', startUtc: SLOT, dateIst: '23 Oct 2026', timeIst: '9:00 AM', ...over })
const suggestion = (over = {}) => ({ path: 'ai', urgency: 'routine', emergency: false, department: { id: 7, name: 'Cardiology' }, reason: 'Palpitations are looked at by cardiology.', preferred: { date: null, timeOfDay: 'any', matched: null }, options: [option(), option({ doctorId: 3, doctorName: 'Dr Heart Two', startUtc: '2026-10-23T04:00:00.000Z', timeIst: '9:30 AM' }), option({ startUtc: '2026-10-23T05:00:00.000Z', timeIst: '10:30 AM' })], departments: [], ...over })
const patient = { id: 1, role: 'patient', name: 'Asha', email: 'a@b.test', emailVerified: true }

function Probe() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p> }
const pages = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route element={<PatientLayout />}>
        <Route index element={<Home />} />
        <Route path="/doctors" element={<Doctors />} />
        <Route path="/book-with-ai" element={<BookWithAI />} />
        <Route path="/book" element={<Book />} />
      </Route>
      <Route path="*" element={<Probe />} />
    </Routes>
    <Probe />
  </MemoryRouter>
)

beforeEach(() => {
  sessionStorage.clear()
  state.user = patient
  state.api = async (p) => (p.startsWith('/public/doctors') ? { doctors: [] } : { departments: [] })
})
afterEach(cleanup)

describe('where the "Book with AI" button appears: signed-in patients only', () => {
  const aiLinks = () => screen.queryAllByRole('link').filter((a) => /Book with AI/.test(a.textContent))
  for (const [label, user, expected] of [['a signed-in patient', patient, 2], ['the admin', { id: 2, role: 'admin', name: 'Admin' }, 0], ['a doctor', { id: 3, role: 'doctor', name: 'Dr' }, 0], ['a signed-out visitor', null, 0]]) {
    for (const [pageName, path] of [['Home', '/'], ['Find a doctor', '/doctors']]) {
      it(`${pageName}, ${label}: ${expected ? 'the top navigation item and the page button' : 'no Book with AI link at all'}`, () => {
        state.user = user
        pages(path)
        const links = aiLinks()
        expect(links).toHaveLength(expected)
        for (const a of links) expect(a.getAttribute('href')).toBe('/book-with-ai')
        if (expected) {
          expect(within(screen.getByRole('navigation', { name: 'Main' })).getByText('Book with AI')).toBeTruthy() // the nav item
          expect(screen.getAllByTestId('book-with-ai-button')).toHaveLength(1) // and one prominent button on the page
        }
      })
    }
  }
})

describe('the Book with AI page', () => {
  const write = (text) => fireEvent.change(screen.getByLabelText('Describe what you need'), { target: { value: text } })
  const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send' }))

  it('is a chat-style box with a 500 character limit, a counter, and the "not a diagnosis" note', () => {
    pages('/book-with-ai')
    const box = screen.getByLabelText('Describe what you need')
    expect(box.getAttribute('maxlength')).toBe('500')
    expect(screen.getByTestId('ai-note').textContent).toBe('This suggests a department. It is not a diagnosis.')
    expect(screen.getByTestId('counter').textContent).toBe('0/500')
    write('abc')
    expect(screen.getByTestId('counter').textContent).toBe('3/500')
    write('ab')
    expect(screen.getByRole('button', { name: 'Send' }).disabled).toBe(true) // too short to send
  })

  it('sends only the typed text, then shows the department, the reason and up to 3 real options with "Book this slot"', async () => {
    const calls = []
    state.api = async (p, opts) => { calls.push([p, opts]); return { suggestion: suggestion() } }
    pages('/book-with-ai')
    write('I get palpitations when I climb stairs')
    send()
    await screen.findByTestId('suggestion')
    expect(calls).toEqual([['/patient/book-with-ai', { method: 'POST', body: { text: 'I get palpitations when I climb stairs' } }]])
    expect(screen.getByTestId('department').textContent).toBe('Cardiology')
    expect(screen.getByText('Palpitations are looked at by cardiology.')).toBeTruthy()
    expect(screen.getByText('Suggested by AI.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Book this slot' })).toHaveLength(3)
    expect(screen.getAllByText('This suggests a department. It is not a diagnosis.').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('I get palpitations when I climb stairs')).toBeTruthy() // the chat shows what was typed
  })

  it('"Book this slot" opens the existing booking form for that doctor and slot, and hands over the patient\'s words as the reason', async () => {
    state.api = async () => ({ suggestion: suggestion() })
    pages('/book-with-ai')
    write('I get palpitations when I climb stairs')
    send()
    await screen.findByTestId('suggestion')
    fireEvent.click(screen.getAllByRole('button', { name: 'Book this slot' })[0])
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('/book?doctor=2&slot=2026-10-23T03:30:00.000Z'))
    expect(readAiReason(2, SLOT)).toBe('I get palpitations when I climb stairs')
    expect(readAiReason(3, SLOT)).toBe('') // only for exactly the suggested doctor and slot
    expect(readAiReason(2, '2026-10-24T03:30:00.000Z')).toBe('')
    expect(window.location.search).not.toContain('palpitations') // never in the address
  })

  it('an emergency shows "call 108 now" and no booking options and no department', async () => {
    state.api = async () => ({ suggestion: suggestion({ emergency: true, urgency: 'emergency', department: null, options: [], reason: '' }) })
    pages('/book-with-ai')
    write('severe chest pain and I cannot breathe')
    send()
    await screen.findByText('If this is an emergency, call 108 now.')
    expect(screen.queryByRole('button', { name: 'Book this slot' })).toBeNull()
    expect(screen.queryByTestId('department')).toBeNull()
  })

  it('"should be seen soon" is said clearly, and the keyword fallback says it was not the AI', async () => {
    state.api = async () => ({ suggestion: suggestion({ path: 'fallback', urgency: 'soon' }) })
    pages('/book-with-ai')
    write('high fever since yesterday')
    send()
    await screen.findByText(/should be seen soon\. Pick the earliest slot/)
    expect(screen.getByText(/simple keyword rules.*AI was not available/)).toBeTruthy()
  })

  it('when nothing matched: every department is listed with a link to its doctors, plus a link to Find a doctor', async () => {
    state.api = async () => ({ suggestion: suggestion({ path: 'fallback', department: null, reason: '', options: [], departments: [{ id: 1, name: 'Cardiology' }, { id: 2, name: 'ENT' }] }) })
    pages('/book-with-ai')
    write('a question about something')
    send()
    const list = await screen.findByTestId('all-departments')
    expect(within(list).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Cardiology', '/doctors?department=1'], ['ENT', '/doctors?department=2']])
    expect(screen.getAllByRole('link', { name: 'Find a doctor' }).some((a) => a.getAttribute('href') === '/doctors')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Book this slot' })).toBeNull()
  })

  it('a department with no free slot says so instead of showing anything made up', async () => {
    state.api = async () => ({ suggestion: suggestion({ options: [] }) })
    pages('/book-with-ai')
    write('heart check')
    send()
    await screen.findByText(/no free slots in Cardiology right now/)
    expect(screen.queryByRole('button', { name: 'Book this slot' })).toBeNull()
  })

  it('the rate-limit message is shown in a friendly way, with a way forward', async () => {
    state.api = async () => { throw new ApiError(429, 'You have used your 10 Book with AI suggestions for this hour. Please try again later, or use Find a doctor.', { code: 'rate_limited' }) }
    pages('/book-with-ai')
    write('heart check')
    send()
    await screen.findByText(/used your 10 Book with AI suggestions for this hour/)
    expect(screen.getAllByRole('link', { name: 'Find a doctor' }).length).toBeGreaterThan(0)
  })
})

describe('the existing booking form: pre-filled for a suggested slot, unchanged otherwise', () => {
  const doctor = { id: 2, name: 'Dr Heart One', department: 'Cardiology', fee: 500, photoUrl: '', languages: [], qualification: '', experienceYears: 3, nextAvailable: null }
  const booking = () => {
    const posts = []
    state.api = async (p, opts) => {
      if (p === '/public/doctors/2') return { doctor }
      if (p.startsWith('/public/doctors/2/slots')) return { days: [{ date: '2026-10-23', dayOfMonth: 23, month: 'Oct', slots: [{ startUtc: SLOT, timeIst: '9:00 AM', state: 'free' }] }] }
      if (p === '/patient/appointments') { posts.push(opts.body); return { appointment: { id: 9, doctorName: 'Dr Heart One', department: 'Cardiology', startIst: '23 Oct 2026, 9:00 AM' } } }
      return p.startsWith('/public/doctors') ? { doctors: [] } : { departments: [] }
    }
    return posts
  }
  const reasonBox = () => screen.findByLabelText(/Reason for visit/)

  it('opens at the details step with the doctor, date and time, and the reason already written', async () => {
    const posts = booking()
    sessionStorage.setItem('curevia.aiBookingReason', JSON.stringify({ doctorId: 2, startUtc: SLOT, text: 'I get palpitations when I climb stairs' }))
    pages(`/book?doctor=2&slot=${SLOT}`)
    expect((await reasonBox()).value).toBe('I get palpitations when I climb stairs')
    expect(screen.getByRole('heading', { name: 'Your details' })).toBeTruthy()
    expect((await screen.findAllByText('23 Oct 2026')).length).toBeGreaterThan(0) // the summary: date
    expect(screen.getAllByText('9:00 AM').length).toBeGreaterThan(0) // and time
    expect(screen.getAllByText('Dr Heart One').length).toBeGreaterThan(0)
    // the patient still confirms everything on the normal form
    fireEvent.change(screen.getByLabelText("Patient's full name"), { target: { value: 'Asha Patient' } })
    fireEvent.change(screen.getByLabelText('Age'), { target: { value: '34' } })
    fireEvent.change(screen.getByLabelText('Gender'), { target: { value: 'female' } })
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+91 98765 43210' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request appointment' }))
    await screen.findByText('Request received')
    expect(posts).toEqual([expect.objectContaining({ doctorId: 2, startUtc: SLOT, reason: 'I get palpitations when I climb stairs', name: 'Asha Patient' })])
    expect(readAiReason(2, SLOT)).toBe('') // used once, then cleared
  })

  it('the normal booking flow is unchanged: no hand-over means an empty reason; another slot does not get the old words', async () => {
    booking()
    pages(`/book?doctor=2&slot=${SLOT}`)
    expect((await reasonBox()).value).toBe('')
    cleanup()
    booking()
    sessionStorage.setItem('curevia.aiBookingReason', JSON.stringify({ doctorId: 2, startUtc: '2026-10-24T03:30:00.000Z', text: 'old words' }))
    pages(`/book?doctor=2&slot=${SLOT}`)
    expect((await reasonBox()).value).toBe('')
  })
})
