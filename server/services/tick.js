import { purgeExpiredSessions } from '../auth/sessions.js'
import { runReminders } from './reminders.js'

const TIME_BUDGET_MS = 200000 // stop starting new work after this, so a run ends well before the next 5-minute tick
const LOCK_TTL_MS = 600000 // a lock this old is treated as dead (a stuck run must not block every later tick)

// The 5-minute job: reminders, the doctors' morning schedule email (once a day, from 8:00 AM IST), retries, then the agent. Safe to run twice: every send has a unique key, and a run that
// starts while another is still going returns immediately without doing anything (one lock, one run at a time).
// `start()` is what the schedule uses: it returns at once and the work carries on in the background.
// `run()` does the same work and waits for it (the admin's "Check now" and the tests).
export function createTick({ db, config, mailer, notifications, agent, dailySchedule = null, feedback = null, clock = () => new Date(), nowMs = () => Date.now(), budgetMs = TIME_BUDGET_MS, lockTtlMs = LOCK_TTL_MS }) {
  let lock = null // { since } while a run is going

  function acquire() {
    if (lock && nowMs() - lock.since < lockTtlMs) return null
    lock = { since: nowMs() }
    return lock
  }
  const release = (mine) => { if (lock === mine) lock = null }

  async function work() {
    const now = clock()
    const deadline = nowMs() + budgetMs
    const timeUp = () => nowMs() >= deadline
    const reminders = await runReminders({ db, config, mailer, now, timeUp })
    const daily = !dailySchedule ? null : timeUp() ? { skipped: 'out of time' } : await dailySchedule.run({ now, timeUp })
    const feedbackSummary = !feedback ? null : timeUp() ? { skipped: 'out of time' } : await feedback.run({ now, timeUp })
    const retried = timeUp() ? 0 : await notifications.retryFailed({ timeUp })
    const agentSummary = timeUp() ? { skipped: 'out of time' } : await agent.run({ timeUp })
    purgeExpiredSessions(db, now)
    return { at: now.toISOString(), reminders, daily, feedback: feedbackSummary, retried, agent: agentSummary, ...(timeUp() ? { cutShort: true } : {}) }
  }

  async function run() {
    const mine = acquire()
    if (!mine) return { skipped: 'already running' }
    try {
      return await work()
    } finally {
      release(mine)
    }
  }

  // Takes the lock now (so the answer is accurate) and runs in the background. Never throws, never waits.
  function start() {
    const mine = acquire()
    if (!mine) return { started: false, skipped: 'already running' }
    work()
      .then((r) => console.log(`Tick done: ${r.reminders?.sent ?? 0} reminders sent, ${r.retried} retried, ${r.agent?.decisions ?? 0} agent decisions${r.cutShort ? ' (cut short by the time limit)' : ''}`))
      .catch((e) => console.error(`Tick failed: ${e?.message}`)) // message only, never data
      .finally(() => release(mine))
    return { started: true }
  }

  return { run, start, isRunning: () => !!lock }
}
