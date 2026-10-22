import 'dotenv/config'
import path from 'node:path'
import { openDb } from '../server/db/index.js'
import { seedDemo, DEMO_PASSWORD } from '../server/seed.js'

// Local testing only. Refuses to touch a production database.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data when NODE_ENV=production.')
  process.exit(1)
}
const dataDir = path.resolve(process.env.DATA_DIR || './data')
const db = openDb(path.join(dataDir, 'curevia.db'))
await seedDemo(db)
console.log(`Demo data added to ${dataDir}. Fake logins (password "${DEMO_PASSWORD}"): anita.rao@example.com, vikram.shah@example.com, meera.iyer@example.com, patient@example.com`)
db.close()
