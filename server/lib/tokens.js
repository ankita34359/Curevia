import crypto from 'node:crypto'

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

// A random secret for links and sessions. Only the hash is ever stored.
export function newToken() {
  const token = crypto.randomBytes(32).toString('base64url')
  return { token, hash: sha256(token) }
}
