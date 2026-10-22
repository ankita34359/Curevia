import path from 'node:path'

const REQUIRED = ['SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']

// The models the viaSocket AI API documents (https://flow.viasocket.com/documentation/ai.md), by service.
// `service` and `model` must be sent together; a model outside its service's list is answered with a 400.
export const AI_MODELS = {
  openai: ['gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash']
}
export const isDocumentedModel = (service, model) => !!AI_MODELS[service]?.includes(model)

// AGENT_DEMO_MINUTES: off unless it is a number from 1 to 120 (the 2-hour mark becomes that many minutes).
export function parseDemoMinutes(raw) {
  if (raw === undefined || String(raw).trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 && n <= 120 ? n : null
}

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
    agent: { service: env.AGENT_SERVICE || 'openai', model: env.AGENT_MODEL || 'gpt-5-mini', demoMinutes: parseDemoMinutes(env.AGENT_DEMO_MINUTES), demoMinutesIgnored: env.AGENT_DEMO_MINUTES !== undefined && String(env.AGENT_DEMO_MINUTES).trim() !== '' && parseDemoMinutes(env.AGENT_DEMO_MINUTES) === null },
    viasocket: {
      orgId: env.VIASOCKET_ORG_ID || '',
      projectId: env.VIASOCKET_PROJECT_ID || '',
      embedSecret: env.VIASOCKET_EMBED_SECRET || '',
      uniqueId: env.VIASOCKET_UNIQUE_ID || 'curevia-hospital'
    }
  }
}
