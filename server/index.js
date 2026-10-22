import 'dotenv/config'
import path from 'node:path'
import { loadConfig } from './config.js'
import { openDb } from './db/index.js'
import { createApp } from './app.js'
import { createMailer } from './services/mailer.js'
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
const mailer = createMailer({ db })
const app = createApp({ config, db, mailer })

const server = app.listen(config.port, config.host, () => console.log(`Curevia listening on ${config.host}:${config.port}`))
const stop = () => server.close(() => { db.close(); process.exit(0) })
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
