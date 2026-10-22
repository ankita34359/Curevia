import bcrypt from 'bcryptjs'

export const PASSWORD_MIN = 8
// bcrypt only reads the first 72 bytes, so longer passwords are refused instead of silently cut.
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`
  if (Buffer.byteLength(pw) > 72) return 'Password is too long (72 bytes at most)'
  return null
}

export const hashPassword = (pw, cost) => bcrypt.hash(pw, cost)
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash)
