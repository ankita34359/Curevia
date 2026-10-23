import { defineConfig } from 'vitest/config'
// Server tests run in node. A client test opts into a browser-like DOM with `// @vitest-environment jsdom` on its first line.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['tests/**/*.test.{js,jsx}'], environment: 'node', testTimeout: 15000 }
})
