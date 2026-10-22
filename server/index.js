import 'dotenv/config'
import path from 'node:path'
import { loadConfig } from './config.js'
import { openDb } from './db/index.js'
import { createApp } from './app.js'
import { buildServices } from './services/index.js'
import { ensureAdmin } from './services/bootstrap.js'

let config
try {
  config = loadConfig()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const db = openDb(path.join(config.dataDir, 'curevia.db'))
await ensureAdmin(db, config)
const services = buildServices({ config, db })
if (!services.viasocket.configured) console.warn(`viaSocket is not set up yet (missing: ${services.viasocket.missing.join(', ')}). Emails, the sheet and Slack stay off until it is.`)
const app = createApp({ config, db, ...services })

const server = app.listen(config.port, config.host, () => console.log(`Curevia listening on ${config.host}:${config.port}`))
const stop = () => server.close(() => { db.close(); process.exit(0) })
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
