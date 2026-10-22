import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

// viaSocket's own check script: finds invented ids, hand-built URLs and a hard-coded secret.
// It asks viaSocket's public catalog, so it needs internet. Set SKIP_VIASOCKET_CHECK=1 to skip offline.
describe.skipIf(process.env.SKIP_VIASOCKET_CHECK === '1')('viaSocket check script', () => {
  it('reports 0 FAIL over server/ and client/src/', () => {
    const r = spawnSync(process.execPath, ['scripts/viasocket-check.mjs', 'server', 'client/src'], { encoding: 'utf8', timeout: 60000 })
    expect(r.stdout + r.stderr).toMatch(/0 FAIL/)
    expect(r.status).toBe(0)
  })
})
