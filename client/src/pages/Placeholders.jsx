import { useAuth } from '../lib/auth.jsx'

// Stage 1 landing pages so each role can sign in and see its own area. Replaced in stages 2 and 3.
export function RoleHome({ label }) {
  const { user } = useAuth()
  return (
    <div className="card animate-fade-up p-8">
      <h1 className="text-2xl font-bold">Hello, {user.name}</h1>
      <p className="mt-2 text-ink-soft">You are signed in as {label}. The tools for this area arrive in the next stages.</p>
    </div>
  )
}

export function HomePlaceholder() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-24 text-center animate-fade-up">
      <h1 className="text-4xl font-bold">Book a hospital appointment in minutes</h1>
      <p className="mt-3 text-ink-soft">The full home page and booking flow are coming in stage 3.</p>
    </div>
  )
}
