import { createIntegrations } from './integrations.js'
import { createMailer } from './mailer.js'
import { createNotifications } from './notifications.js'
import { createNotifier } from './notifier.js'
import { createViaSocketService } from './viasocket.js'
import { createAgent } from './agent/index.js'
import { createTick } from './tick.js'
import { createDailySchedule } from './dailySchedule.js'

// Builds the connected set of services. `client` and `fetchImpl` are swapped for fakes in the tests.
export function buildServices({ config, db, clock = () => new Date(), client = null, fetchImpl = globalThis.fetch, timeouts = {} }) {
  const viasocket = createViaSocketService({ config, client, fetchImpl, ...timeouts })
  const integrations = createIntegrations({ db, viasocket, clock })
  const mailer = createMailer({ db, now: clock, transport: { sendEmail: ({ to, subject, body }) => integrations.send('email_sender', { to, subject, body }) } })
  const notifications = createNotifications({ db, config, mailer, integrations, clock })
  const notifier = createNotifier({ handlers: [notifications.handle] })
  const agent = createAgent({ db, config, viasocket, mailer, notifications, clock, model: config.agent })
  const dailySchedule = createDailySchedule({ db, config, mailer, clock })
  const tick = createTick({ db, config, mailer, notifications, agent, dailySchedule, clock })
  return { viasocket, integrations, mailer, notifications, notifier, agent, dailySchedule, tick }
}
