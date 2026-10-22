import { describe, it, expect } from 'vitest'
import { openDb } from '../server/db/index.js'
import { seedDemo } from '../server/seed.js'
import { makeApp, agentFor, addDoctor } from './helpers.js'

describe('demo seed', () => {
  it('creates 6 departments with 2 doctors each, all with availability, and is repeatable', async () => {
    const db = openDb(':memory:')
    await seedDemo(db, { cost: 4 })
    await seedDemo(db, { cost: 4 })
    const rows = db
      .prepare('SELECT dep.name, COUNT(d.id) AS n, MIN((SELECT COUNT(*) FROM availability a WHERE a.doctor_id = d.id)) AS windows FROM departments dep JOIN doctors d ON d.department_id = dep.id GROUP BY dep.id')
      .all()
    expect(rows.map((r) => r.name)).toEqual(['General Medicine', 'Pediatrics', 'Cardiology', 'Orthopedics', 'Dermatology', 'ENT'])
    expect(rows.every((r) => r.n === 2 && r.windows > 0)).toBe(true)
  })
})

describe('doctor profile data', () => {
  it('lists the next free slots and 404s for unknown or inactive doctors', async () => {
    const { app, db } = await makeApp()
    const { doctorId } = addDoctor(db)
    const res = await agentFor(app).get(`/api/public/doctors/${doctorId}/next-slots`).expect(200)
    expect(res.body.slots.length).toBeGreaterThan(0)
    expect(res.body.slots[0]).toMatchObject({ dayIst: '2026-10-22' })
    await agentFor(app).get('/api/public/doctors/999/next-slots').expect(404)
  })
})

import { createHoldingApp } from '../server/holding.js'
import supertest from 'supertest'
describe('holding page when settings are missing', () => {
  it('answers /healthz, and 503 with only names elsewhere', async () => {
    const app = createHoldingApp('Server is missing settings. Missing required environment variables: SESSION_SECRET, ADMIN_PASSWORD')
    expect((await supertest(app).get('/healthz')).body).toEqual({ ok: true, ready: false })
    const api = await supertest(app).get('/api/public/doctors')
    expect(api.status).toBe(503)
    expect(api.body.error).toMatch(/SESSION_SECRET, ADMIN_PASSWORD/)
    const page = await supertest(app).get('/admin')
    expect(page.status).toBe(503)
    expect(page.text).not.toMatch(/SESSION_SECRET/)
  })
})
