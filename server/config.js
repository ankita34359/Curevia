import path from 'node:path'

const REQUIRED = ['SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']

// Reads configuration from environment variables. Only names are ever reported, never values.
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k])
  const isProd = env.NODE_ENV === 'production'
  if (isProd && !env.APP_URL) missing.push('APP_URL')
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  if (env.SESSION_SECRET.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters')
  if (env.ADMIN_PASSWORD.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters')

  const port = Number(env.PORT) || 3000
  return {
    isProd,
    port,
    host: '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    sessionSecret: env.SESSION_SECRET,
    adminEmail: env.ADMIN_EMAIL.trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD,
    cronSecret: env.CRON_SECRET || '',
    trustProxy: env.TRUST_PROXY === undefined ? 1 : Number(env.TRUST_PROXY),
    bcryptCost: Number(env.BCRYPT_COST) || 12,
    loginRateLimit: { windowMs: 15 * 60 * 1000, max: 10 },
    agent: { service: env.AGENT_SERVICE || 'openai', model: env.AGENT_MODEL || 'gpt-5-mini' },
    viasocket: {
      orgId: env.VIASOCKET_ORG_ID || '',
      projectId: env.VIASOCKET_PROJECT_ID || '',
      embedSecret: env.VIASOCKET_EMBED_SECRET || '',
      uniqueId: env.VIASOCKET_UNIQUE_ID || 'curevia-hospital'
    }
  }
}
