import 'dotenv/config'
import path from 'node:path'
import { loadConfig } from './config.js'
import { createHoldingApp } from './holding.js'
import { openDb } from './db/index.js'
import { createApp } from './app.js'
import { buildServices } from './services/index.js'
import { ensureAdmin } from './services/bootstrap.js'

let config
try {
  config = loadConfig()
} catch (e) {
  // Stay up with a holding page instead of crashing, so a missing setting is obvious from outside and in the logs.
  console.error(`${e.message}. Serving a holding page until it is set and the app is restarted.`)
  const port = Number(process.env.PORT) || 3000
  createHoldingApp(`Server is missing settings. ${e.message}`, { cronSecret: process.env.CRON_SECRET || '' }).listen(port, '0.0.0.0', () => console.log(`Curevia (holding page) listening on 0.0.0.0:${port}`))
  await new Promise(() => {})
}

const dbFile = path.join(config.dataDir, 'curevia.db')
const db = openDb(dbFile)
console.log(`Database: ${dbFile}`)
await ensureAdmin(db, config)
const services = buildServices({ config, db })
if (!services.viasocket.configured) console.warn(`viaSocket is not set up yet (missing: ${services.viasocket.missing.join(', ')}). Emails, the sheet and Slack stay off until it is.`)
const app = createApp({ config, db, ...services })

const server = app.listen(config.port, config.host, () => console.log(`Curevia listening on ${config.host}:${config.port}`))
const stop = () => server.close(() => { db.close(); process.exit(0) })
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
