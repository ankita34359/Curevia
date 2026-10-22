import { purgeExpiredSessions } from '../auth/sessions.js'
import { runReminders } from './reminders.js'

// The 5-minute job: reminders, retries, then the agent. Safe to run twice: every send has a unique key and a second
// run that overlaps the first returns immediately.
export function createTick({ db, config, mailer, notifications, agent, clock = () => new Date() }) {
  let running = false
  async function run() {
    if (running) return { skipped: 'already running' }
    running = true
    try {
      const now = clock()
      const reminders = await runReminders({ db, config, mailer, now })
      const retried = await notifications.retryFailed()
      const agentSummary = await agent.run()
      purgeExpiredSessions(db, now)
      return { at: now.toISOString(), reminders, retried, agent: agentSummary }
    } finally {
      running = false
    }
  }
  return { run }
}
