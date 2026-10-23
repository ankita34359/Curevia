import { describe, it, expect, vi } from 'vitest'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, ADMIN } from './helpers.js'
import { BOOKING_PROMPT, keywordSuggestion, redact } from '../server/services/bookingAssistant.js'
import { findBookableSlot } from '../server/services/scheduling.js'
import { addDays, istDate, istTime } from '../server/lib/time.js'

const never = () => new Promise(() => {})
const say = (content) => () => ({ content, finishReason: 'completed' })
const pick = (department, over = {}) => say({ department, urgency: 'routine', reason: 'It fits what you wrote.', preferred_date: '', preferred_time_of_day: 'any', ...over })
const ask = (agent, text) => agent.post('/api/patient/book-with-ai').send({ text })
const NOW = '2026-10-22T04:00:00.000Z' // Thu 22 Oct 2026, 09:30 IST
const BOOKING = (doctorId, startUtc) => ({ doctorId, startUtc, name: 'Asha Patient', age: 34, gender: 'female', phone: '+91 98765 43210', email: 'pat@test.local', reason: 'Skin rash' })

// Cardiology (2 active doctors + 1 inactive), General Medicine, Dermatology, an inactive department, one with only an inactive doctor.
async function world(opts = {}) {
  const w = await makeApp(opts)
  const heart1 = addDoctor(w.db, { email: 'heart1@test.local', name: 'Dr Heart One', dept: 'Cardiology' })
  const heart2 = addDoctor(w.db, { email: 'heart2@test.local', name: 'Dr Heart Two', dept: 'Cardiology' })
  const gone = addDoctor(w.db, { email: 'gone@test.local', name: 'Dr Inactive', dept: 'Cardiology' })
  const gen = addDoctor(w.db, { email: 'gen@test.local', name: 'Dr General', dept: 'General Medicine' })
  const skin = addDoctor(w.db, { email: 'skin@test.local', name: 'Dr Skin', dept: 'Dermatology' })
  const hidden = addDoctor(w.db, { email: 'hid@test.local', name: 'Dr Hidden', dept: 'Hidden Dept' })
  const onlyGone = addDoctor(w.db, { email: 'og@test.local', name: 'Dr Gone Too', dept: 'Empty Dept' })
  w.db.prepare('UPDATE doctors SET active = 0 WHERE id IN (?, ?)').run(gone.doctorId, onlyGone.doctorId)
  w.db.prepare("UPDATE departments SET active = 0 WHERE name = 'Hidden Dept'").run()
  const patientId = addPatient(w.db, 'pat@test.local', 'Asha Patient')
  const patient = await login(w.app, 'pat@test.local', 'password-123')
  const depId = (name) => w.db.prepare('SELECT id FROM departments WHERE name = ?').get(name).id
  const aiLog = () => w.db.prepare('SELECT * FROM ai_booking_log ORDER BY id').all()
  return { ...w, heart1, heart2, gone, gen, skin, hidden, patientId, patient, depId, aiLog, now: () => w.clock.now.toISOString() }
}
const DEPARTMENTS = ['Cardiology', 'Dermatology', 'General Medicine'] // the bookable ones, in name order

describe('the department must be exactly one of the real ones', () => {
  it('a valid AI answer is used: the department, the reason and the path are returned', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology', { reason: 'Palpitations are looked at by cardiology.' })
    const r = await ask(w.patient, 'I get palpitations when I climb stairs')
    expect(r.status).toBe(200)
    expect(r.body.suggestion).toMatchObject({ path: 'ai', urgency: 'routine', emergency: false, department: { id: w.depId('Cardiology'), name: 'Cardiology' }, reason: 'Palpitations are looked at by cardiology.' })
    expect(w.aiLog()).toEqual([expect.objectContaining({ path: 'ai', fallback_reason: null, department_id: w.depId('Cardiology'), urgency: 'routine', emergency: 0 })])
  })

  it('the AI is only offered departments that can be booked today (active, with an active doctor)', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology')
    await ask(w.patient, 'heart question')
    const req = w.fake.aiCalls[0]
    expect(JSON.parse(req.message).departments).toEqual(DEPARTMENTS)
    expect(req.jsonSchema.schema.properties.department.enum).toEqual(DEPARTMENTS)
    expect(req.jsonSchema.strict).toBe(true)
    expect(req).toMatchObject({ responseType: 'json_schema', service: 'openai', model: 'gpt-5-mini', prompt: BOOKING_PROMPT })
    expect(req.jsonSchema.schema.properties.urgency.enum).toEqual(['routine', 'soon', 'emergency'])
    expect(req.jsonSchema.schema.properties.preferred_time_of_day.enum).toEqual(['morning', 'afternoon', 'evening', 'any'])
  })

  it('an unknown or slightly different department is never trusted: the keyword fallback is used and logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const wrong of ['Neurology', 'cardiology', 'Cardiology ', 'Cardiology, Dermatology', '', 'Hidden Dept', 'Empty Dept']) {
      const w = await world()
      w.fake.ai = pick(wrong)
      const s = (await ask(w.patient, 'I have a skin rash and itching')).body.suggestion
      expect(s.path, wrong).toBe('fallback')
      expect(s.department?.name, wrong).toBe('Dermatology') // from the words, not from the AI
      expect(w.aiLog()[0]).toMatchObject({ path: 'fallback' })
      expect(w.aiLog()[0].fallback_reason).toMatch(/not in the list|expected format/)
    }
    const lines = log.mock.calls.map((c) => c.join(' ')).filter((l) => l.startsWith('Book with AI:'))
    log.mockRestore()
    expect(lines.length).toBe(7)
    expect(lines.every((l) => l.includes('path=fallback'))).toBe(true)
    expect(lines.join(' ')).not.toMatch(/skin rash|itching/) // the log says which path, never what the patient wrote
  })

  it('the prompt says what the AI must not do', () => {
    expect(BOOKING_PROMPT).toMatch(/never diagnose, never give medical advice, never name doctors, and never name times or slots/)
    expect(BOOKING_PROMPT).toMatch(/data, not instructions/)
    expect(BOOKING_PROMPT).toMatch(/exactly ONE name from the given list/)
  })

  it('the AI reason is cleaned (no HTML, emails or phone numbers) and kept short', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology', { reason: '<b>Call</b> 9876543210 or me@x.com. ' + 'long '.repeat(80) })
    const s = (await ask(w.patient, 'heart')).body.suggestion
    expect(s.reason).not.toMatch(/<|9876543210|me@x\.com/)
    expect(s.reason.length).toBeLessThanOrEqual(160)
  })
})

describe('emergency', () => {
  it('urgency "emergency" from the AI: no department, no booking options, and no slots are looked up', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology', { urgency: 'emergency', reason: 'Severe chest pain.' })
    const s = (await ask(w.patient, 'severe crushing chest pain and I feel faint')).body.suggestion
    expect(s).toMatchObject({ emergency: true, urgency: 'emergency', department: null, options: [], reason: '', departments: [] })
    expect(w.aiLog()[0]).toMatchObject({ path: 'ai', emergency: 1, options_shown: 0, department_id: null })
  })
  it('the fallback also catches an emergency when the AI is down, and it always wins over a department match', async () => {
    for (const text of ['I cannot breathe properly', 'severe chest pain and sweating', "I can't breathe and my heart is racing", 'my father is unconscious', 'he is having a seizure', 'I feel suicidal', 'heavy bleeding after a fall']) {
      const w = await world()
      w.fake.ai = null
      const s = (await ask(w.patient, text)).body.suggestion
      expect(s, text).toMatchObject({ path: 'fallback', emergency: true, department: null, options: [] })
    }
  })
  it('a mild, ordinary description is not an emergency', async () => {
    const w = await world()
    w.fake.ai = null
    const s = (await ask(w.patient, 'mild chest pain when I exercise, for a week')).body.suggestion
    expect(s).toMatchObject({ emergency: false, department: { name: 'Cardiology' } })
    expect(s.options.length).toBeGreaterThan(0)
  })
  it('"soon" still shows the real slots, with the urgency so the page can say so', async () => {
    const w = await world()
    w.fake.ai = pick('General Medicine', { urgency: 'soon' })
    const s = (await ask(w.patient, 'high fever since yesterday')).body.suggestion
    expect(s).toMatchObject({ urgency: 'soon', emergency: false })
    expect(s.options.length).toBeGreaterThan(0)
  })
})

describe('only real free slots are shown', () => {
  it('up to 3 options, all genuinely bookable, all in the suggested department, different doctors first', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology')
    const s = (await ask(w.patient, 'heart check')).body.suggestion
    expect(s.options).toHaveLength(3)
    const doctors = new Set(s.options.map((o) => o.doctorId))
    expect(doctors).toEqual(new Set([w.heart1.doctorId, w.heart2.doctorId])) // the two active cardiologists, never the inactive one or other departments
    expect(doctors.has(w.gone.doctorId)).toBe(false)
    for (const o of s.options) {
      expect(findBookableSlot(w.db, o.doctorId, o.startUtc, w.now())).toBeTruthy() // the same check the booking itself uses
      expect(o.department).toBe('Cardiology')
      expect(o.dateIst).toMatch(/^\d{1,2} [A-Z][a-z]{2} 2026$/)
      expect(o.timeIst).toMatch(/^\d{1,2}:\d{2} [AP]M$/)
    }
    expect(s.options.map((o) => o.startUtc)).toEqual([...s.options.map((o) => o.startUtc)].sort()) // earliest first
    expect(s.options[0].startUtc > w.now()).toBe(true)
  })

  it('slots that are booked, in the past, on a leave day, or belong to an inactive doctor are never offered', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology')
    const first = (await ask(w.patient, 'heart')).body.suggestion.options
    // book the first suggestion for real: it must not come back
    const booked = await w.patient.post('/api/patient/appointments').send(BOOKING(first[0].doctorId, first[0].startUtc))
    expect(booked.status).toBe(201)
    const again = (await ask(w.patient, 'heart')).body.suggestion.options
    expect(again.some((o) => o.doctorId === first[0].doctorId && o.startUtc === first[0].startUtc)).toBe(false)
    // take Dr Heart One's whole next working day away (leave): only Dr Heart Two is offered on that day
    const day = istDate(first[0].startUtc)
    w.db.prepare('INSERT INTO leaves (doctor_id, date, reason) VALUES (?, ?, ?)').run(w.heart1.doctorId, day, 'Leave')
    for (const o of (await ask(w.patient, 'heart')).body.suggestion.options) expect(findBookableSlot(w.db, o.doctorId, o.startUtc, w.now())).toBeTruthy()
    const onLeave = (await ask(w.patient, 'heart')).body.suggestion.options.filter((o) => o.doctorId === w.heart1.doctorId && istDate(o.startUtc) === day)
    expect(onLeave).toHaveLength(0)
  })

  it('a department with a single doctor still gives up to 3 different free slots of that doctor', async () => {
    const w = await world()
    w.fake.ai = pick('Dermatology')
    const s = (await ask(w.patient, 'rash')).body.suggestion
    expect(s.options).toHaveLength(3)
    expect(new Set(s.options.map((o) => o.doctorId))).toEqual(new Set([w.skin.doctorId]))
    expect(new Set(s.options.map((o) => o.startUtc)).size).toBe(3)
  })

  it('no free slots at all: the department is suggested with an empty list (no invented slots)', async () => {
    const w = await world()
    w.fake.ai = pick('Dermatology')
    w.db.prepare('DELETE FROM availability WHERE doctor_id = ?').run(w.skin.doctorId)
    const s = (await ask(w.patient, 'rash')).body.suggestion
    expect(s).toMatchObject({ department: { name: 'Dermatology' }, options: [], departments: [] })
    expect(w.aiLog()[0].options_shown).toBe(0)
  })

  it('the preferred day and time of day are respected when the AI mentions them', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology', { preferred_date: '2026-10-23', preferred_time_of_day: 'morning' }) // Fri
    const s = (await ask(w.patient, 'heart, tomorrow morning')).body.suggestion
    expect(s.preferred).toEqual({ date: '2026-10-23', timeOfDay: 'morning', matched: 'full' })
    expect(s.options.length).toBeGreaterThan(0)
    for (const o of s.options) { expect(istDate(o.startUtc)).toBe('2026-10-23'); expect(Number(istTime(o.startUtc).slice(0, 2))).toBeLessThan(12) }
  })
  it('if that time of day is not free the same date is shown; if that date is not free the next available are shown, and it says so', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology', { preferred_date: '2026-10-23', preferred_time_of_day: 'evening' }) // doctors work 09:00-12:00
    const partial = (await ask(w.patient, 'heart tomorrow evening')).body.suggestion
    expect(partial.preferred.matched).toBe('partial')
    expect(partial.options.every((o) => istDate(o.startUtc) === '2026-10-23')).toBe(true)
    w.fake.ai = pick('Cardiology', { preferred_date: '2026-10-24' }) // Saturday: nobody works
    const none = (await ask(w.patient, 'heart on saturday')).body.suggestion
    expect(none.preferred.matched).toBe('none')
    expect(none.options.length).toBeGreaterThan(0)
    expect(none.options.every((o) => istDate(o.startUtc) !== '2026-10-24')).toBe(true)
  })
  it('a date in the past, beyond the booking horizon, or not a date is ignored', async () => {
    for (const bad of ['2026-10-20', '2027-03-01', 'tomorrow', '23/10/2026', '2026-13-45']) {
      const w = await world()
      w.fake.ai = pick('Cardiology', { preferred_date: bad })
      const s = (await ask(w.patient, 'heart')).body.suggestion
      expect(s.preferred, bad).toEqual({ date: null, timeOfDay: 'any', matched: null })
      expect(s.options.length, bad).toBeGreaterThan(0)
    }
  })
  it('the fallback understands "tomorrow", a weekday and a time of day in plain words', () => {
    const deps = [{ id: 1, name: 'Cardiology' }]
    expect(keywordSuggestion('heart check tomorrow morning', deps, '2026-10-22')).toMatchObject({ date: '2026-10-23', timeOfDay: 'morning' })
    expect(keywordSuggestion('heart check on monday afternoon', deps, '2026-10-22')).toMatchObject({ date: '2026-10-26', timeOfDay: 'afternoon' })
    expect(keywordSuggestion('heart check day after tomorrow evening', deps, '2026-10-22')).toMatchObject({ date: '2026-10-24', timeOfDay: 'evening' })
    expect(keywordSuggestion('heart check today', deps, '2026-10-22')).toMatchObject({ date: '2026-10-22' })
    expect(keywordSuggestion('heart check', deps, '2026-10-22')).toMatchObject({ date: null, timeOfDay: 'any' })
  })
})

describe('the suggestion changes nothing; booking stays on the existing form', () => {
  it('no appointment, email, sheet row, Slack message or agent log is created by a suggestion', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology')
    const count = () => ['appointments', 'appointment_events', 'deliveries', 'agent_log', 'agent_cases', 'feedback', 'lab_reports'].map((t) => w.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n)
    const before = count()
    await ask(w.patient, 'heart')
    await w.notifier.flush()
    expect(count()).toEqual(before)
    expect(w.emails.sent).toHaveLength(0)
    expect(w.fake.posts).toHaveLength(0)
  })
  it('booking a suggested slot through the existing endpoint runs all the existing automation as before', async () => {
    const w = await world()
    w.fake.ai = pick('Dermatology')
    const o = (await ask(w.patient, 'rash')).body.suggestion.options[0]
    const r = await w.patient.post('/api/patient/appointments').send(BOOKING(o.doctorId, o.startUtc))
    expect(r.status).toBe(201)
    await w.notifier.flush()
    expect(r.body.appointment.status).toBe('pending')
    expect(w.fake.postsTo('appointments_sheet').map((p) => p.event)).toEqual(['booked'])
    expect(w.emails.sent.map((m) => m.to).sort()).toEqual(['pat@test.local', 'skin@test.local'])
  })
})

describe('who can use it', () => {
  it('patients only: signed-out visitors, doctors and the admin are refused', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology')
    const doctor = await login(w.app, 'heart1@test.local', 'password-123')
    const admin = await login(w.app, ADMIN.email, ADMIN.password)
    expect((await ask(agentFor(w.app), 'heart')).status).toBe(401)
    expect((await ask(doctor, 'heart')).status).toBe(403)
    expect((await ask(admin, 'heart')).status).toBe(403)
    expect((await ask(w.patient, 'heart')).status).toBe(200)
    expect(w.fake.aiCalls).toHaveLength(1) // refused callers never reach the AI
  })
})

describe('rate limit: 10 suggestions per patient per hour', () => {
  it('the 11th is refused with a friendly message; another patient is not affected', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology')
    for (let i = 1; i <= 10; i++) expect((await ask(w.patient, `heart question ${i}`)).status, `request ${i}`).toBe(200)
    const blocked = await ask(w.patient, 'one more')
    expect(blocked.status).toBe(429)
    expect(blocked.body.code).toBe('rate_limited')
    expect(blocked.body.error).toMatch(/used your 10 Book with AI suggestions for this hour.*try again later.*Find a doctor/)
    expect(w.fake.aiCalls).toHaveLength(10) // the refused one never called the AI
    addPatient(w.db, 'other@test.local', 'Other Patient')
    const other = await login(w.app, 'other@test.local', 'password-123')
    expect((await ask(other, 'heart')).status).toBe(200)
  })
  it('fallback answers count too (every request is an AI attempt)', async () => {
    const w = await world()
    w.fake.ai = null
    for (let i = 0; i < 10; i++) await ask(w.patient, 'skin rash')
    expect((await ask(w.patient, 'skin rash')).status).toBe(429)
  })
})

describe('when the AI cannot be used: keyword rules', () => {
  const CASES = [['I have a skin rash and itching', 'Dermatology'], ['heart palpitations at night', 'Cardiology'], ['fever and cough for 3 days', 'General Medicine'], ['I feel very tired and have a headache', 'General Medicine']]
  it('maps plain words to the real departments, for every way the AI can fail', async () => {
    const failures = [null, () => { throw new Error('502 from viaSocket') }, say({ nonsense: true }), say('not json'), say({ department: 'Cardiology', urgency: 'dance', reason: 'x', preferred_date: '', preferred_time_of_day: 'any' })]
    for (const ai of failures) {
      const w = await world()
      w.fake.ai = ai
      for (const [text, dep] of CASES) {
        const s = (await ask(w.patient, text)).body.suggestion
        expect(s.path).toBe('fallback')
        expect(s.department.name, text).toBe(dep)
        expect(s.options.length).toBeGreaterThan(0)
      }
    }
  })
  it('an AI that never answers is cut off by the time limit', async () => {
    const w = await world({ timeouts: { aiTimeoutMs: 30 } })
    w.fake.ai = never
    const t0 = Date.now()
    const s = (await ask(w.patient, 'skin rash')).body.suggestion
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(s).toMatchObject({ path: 'fallback', department: { name: 'Dermatology' } })
    expect(w.aiLog()[0].fallback_reason).toMatch(/did not answer in time/)
  })
  it('works when viaSocket is not set up at all', async () => {
    const w = await world()
    w.ctx.viasocket.ai = async () => { throw new Error('viaSocket is not set up: missing VIASOCKET_ORG_ID') }
    expect((await ask(w.patient, 'skin rash')).body.suggestion.path).toBe('fallback')
  })
  it('only departments the hospital has are matched (no "Neurology" invented)', async () => {
    const w = await world()
    w.fake.ai = null
    const s = (await ask(w.patient, 'I get migraine headaches and numbness')).body.suggestion
    expect(s.department?.name).toBe('General Medicine') // "headache" matches General Medicine; there is no Neurology department
  })
  it('nothing matches: all real departments are returned (so the page can list them and link to Find a doctor)', async () => {
    const w = await world()
    w.fake.ai = null
    const s = (await ask(w.patient, 'I have a general question about something')).body.suggestion // "general" alone is not a symptom
    expect(s).toMatchObject({ path: 'fallback', emergency: false, department: null, options: [], reason: '' })
    expect(s.departments.map((d) => d.name)).toEqual(DEPARTMENTS)
    expect(s.departments.every((d) => Number.isInteger(d.id))).toBe(true)
    expect(w.aiLog()[0]).toMatchObject({ path: 'fallback', department_id: null, options_shown: 0 })
  })
  it('keyword rules: ties, child words, ENT as a whole word only, and no match in departments that do not exist', () => {
    const deps = [{ id: 1, name: 'General Medicine' }, { id: 2, name: 'Pediatrics' }, { id: 3, name: 'ENT' }, { id: 4, name: 'Dental Care' }]
    const d = (t) => keywordSuggestion(t, deps, '2026-10-22').department
    expect(d('my daughter has a fever and cough')).toBe('Pediatrics')
    expect(d('sore throat and earache')).toBe('ENT')
    expect(d('toothache and swollen gums')).toBe('Dental Care')
    expect(d('I need a prescription of something')).toBeNull()
    expect(keywordSuggestion('urgent, high fever', deps, '2026-10-22').urgency).toBe('soon')
    expect(keywordSuggestion('a normal check up', deps, '2026-10-22').urgency).toBe('routine')
  })
})

describe('no personal data goes to the AI', () => {
  it('only the typed text, the department names and today\'s date are sent: never the patient\'s name, phone, email or id', async () => {
    const w = await world()
    w.fake.ai = pick('Dermatology')
    await ask(w.patient, 'I have a skin rash and itching on my arms')
    const req = w.fake.aiCalls[0]
    expect(Object.keys(JSON.parse(req.message)).sort()).toEqual(['departments', 'patient_text', 'today_ist', 'weekday'])
    expect(JSON.parse(req.message)).toEqual({ patient_text: 'I have a skin rash and itching on my arms', departments: DEPARTMENTS, today_ist: '2026-10-22', weekday: 'thursday' })
    const everything = JSON.stringify(req)
    expect(everything).not.toMatch(/Asha|Patient|pat@test|98765|9000000000/)
    expect(everything).not.toContain(`"userId"`)
    expect(req.threadId).toMatch(/^book-ai-[0-9a-f-]{36}$/)
    await ask(w.patient, 'another question about my skin')
    expect(w.fake.aiCalls[1].threadId).not.toBe(req.threadId) // a fresh thread each time: nothing links requests to a person
  })
  it('a phone number or email address typed into the box is removed before it is sent', async () => {
    const w = await world()
    w.fake.ai = pick('Dermatology')
    await ask(w.patient, 'rash on my arm, call me on +91 98765 43210 or mail asha@example.com')
    const sent = JSON.parse(w.fake.aiCalls[0].message).patient_text
    expect(sent).toBe('rash on my arm, call me on [removed] or mail [removed]')
    expect(redact('plain text, 2 days')).toBe('plain text, 2 days')
  })
  it('the log holds the path and the outcome only: no text, no patient, no personal data', async () => {
    const w = await world()
    w.fake.ai = pick('Dermatology')
    await ask(w.patient, 'my secret rash description')
    const cols = Object.keys(w.db.prepare('SELECT * FROM ai_booking_log').get()).sort()
    expect(cols).toEqual(['created_at', 'department_id', 'emergency', 'fallback_reason', 'id', 'options_shown', 'path', 'urgency'])
    expect(JSON.stringify(w.aiLog())).not.toMatch(/secret|Asha|pat@test/)
  })
})

describe('the text box rules and the admin count', () => {
  it('3 to 500 characters, as text; nothing else is accepted', async () => {
    const w = await world()
    w.fake.ai = pick('Cardiology')
    for (const text of ['', 'ab', '   ', 'x'.repeat(501), 123, null, undefined, ['heart']]) expect((await ask(w.patient, text)).status, String(text).slice(0, 10)).toBe(400)
    expect((await ask(w.patient, 'x'.repeat(500))).status).toBe(200)
    expect((await ask(w.patient, '  heart check  ')).status).toBe(200)
    expect(JSON.parse(w.fake.aiCalls.at(-1).message).patient_text).toBe('heart check') // trimmed
  })
  it('Agent activity gets a simple count of AI versus fallback suggestions', async () => {
    const w = await world()
    const admin = await login(w.app, ADMIN.email, ADMIN.password)
    expect((await admin.get('/api/admin/agent').expect(200)).body.aiBooking).toEqual({ ai: 0, fallback: 0 })
    w.fake.ai = pick('Cardiology')
    await ask(w.patient, 'heart'); await ask(w.patient, 'heart again')
    w.fake.ai = null
    await ask(w.patient, 'skin rash')
    expect((await admin.get('/api/admin/agent').expect(200)).body.aiBooking).toEqual({ ai: 2, fallback: 1 })
  })
})
