import { createIntegrations } from './integrations.js'
import { createMailer } from './mailer.js'
import { createNotifications } from './notifications.js'
import { createNotifier } from './notifier.js'
import { createViaSocketService } from './viasocket.js'

// Builds the connected set of services. `client` and `fetchImpl` are swapped for fakes in the tests.
export function buildServices({ config, db, clock = () => new Date(), client = null, fetchImpl = globalThis.fetch }) {
  const viasocket = createViaSocketService({ config, client, fetchImpl })
  const integrations = createIntegrations({ db, viasocket, clock })
  const mailer = createMailer({ db, now: clock, transport: { sendEmail: ({ to, subject, body }) => integrations.send('email_sender', { to, subject, body }) } })
  const notifications = createNotifications({ db, config, mailer, integrations, clock })
  const notifier = createNotifier({ handlers: [notifications.handle] })
  return { viasocket, integrations, mailer, notifications, notifier }
}
