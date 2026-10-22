# Curevia

Hospital appointment booking. One Node.js process: Express API + React (Vite) + Tailwind client, SQLite storage.

> Work in progress (Phase 1, stage 1 of 6: setup, database, logins and roles). The full README arrives in stage 6.

## Run locally

```bash
cp .env.example .env     # then edit the values
npm install
npm run build            # builds the React client into dist/
npm start                # http://localhost:3000
```

For client development run `npm run dev:server` and `npm run dev:client` in two terminals (Vite proxies /api to port 3000).

## Tests

```bash
npm test                          # all tests (includes viaSocket's check script; needs internet)
SKIP_VIASOCKET_CHECK=1 npm test   # offline
```
