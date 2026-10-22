// Collects "something happened to an appointment" events. Stage 4 plugs in the emails, the Google Sheet row and
// the Slack alert; until then events are only held in memory. emit() never throws and never blocks the request.
export function createNotifier({ handlers = [] } = {}) {
  const inflight = new Set()
  return {
    handlers,
    emit(event, payload) {
      const p = Promise.allSettled(this.handlers.map((h) => h(event, payload))).then((rs) => { for (const r of rs) if (r.status === 'rejected') console.error(`Notification handler for "${event}" failed: ${r.reason?.message}`) }).finally(() => inflight.delete(p))
      inflight.add(p)
      return p
    },
    // Tests (and shutdown) wait for notifications that are still being delivered.
    async flush() {
      while (inflight.size) await Promise.all([...inflight])
    }
  }
}
