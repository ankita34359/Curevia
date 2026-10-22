const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function layout(title, bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#12303a">
  <div style="padding:16px 0;font-size:22px;font-weight:700;color:#0f766e">Curevia</div>
  <h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>
  ${bodyHtml}
  <p style="margin-top:32px;font-size:12px;color:#5b7480">This is an automated message from Curevia. Please do not share this email.</p>
</div>`
}

const button = (href, label) =>
  `<p><a href="${esc(href)}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`

export function verifyEmail({ name, link }) {
  return {
    subject: 'Verify your email for Curevia',
    html: layout('Verify your email', `<p>Hello ${esc(name)},</p><p>Please confirm your email address to start booking appointments. The link works for 48 hours.</p>${button(link, 'Verify my email')}`)
  }
}

export function doctorSetPassword({ name, link }) {
  return {
    subject: 'Set your Curevia password',
    html: layout('Welcome to Curevia', `<p>Hello ${esc(name)},</p><p>An account has been created for you. Choose your password using the button below. The link works for 48 hours and can be used once.</p>${button(link, 'Set my password')}`)
  }
}

export function resetPassword({ name, link }) {
  return {
    subject: 'Reset your Curevia password',
    html: layout('Reset your password', `<p>Hello ${esc(name)},</p><p>Use the button below to choose a new password. The link works for 1 hour and can be used once. If you did not ask for this, you can ignore this email.</p>${button(link, 'Choose a new password')}`)
  }
}

// ---- appointment emails (all times are India time) ----
const row = (k, v) => `<tr><td style="padding:4px 16px 4px 0;color:#5b7480">${esc(k)}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`
const details = (a) =>
  `<table style="margin:12px 0;border-collapse:collapse;font-size:14px">${row('Doctor', a.doctorName)}${row('Department', a.department)}${row('When (IST)', a.startIst)}${a.patientName ? row('Patient', a.patientName) : ''}</table>`

export function patientRequestReceived(a, { link }) {
  return {
    subject: `We received your appointment request for ${a.startIst}`,
    html: layout('Request received', `<p>Hello ${esc(a.patientName)},</p><p>We have received your appointment request. It is <strong>pending</strong> until the doctor confirms, and we will email you as soon as they do.</p>${details(a)}${button(link, 'View my appointments')}`)
  }
}
export function patientConfirmed(a, { link }) {
  return {
    subject: `Your appointment is confirmed: ${a.startIst}`,
    html: layout('Your appointment is confirmed', `<p>Hello ${esc(a.patientName)},</p><p>${esc(a.doctorName)} has confirmed your appointment. We will send you reminders before the visit.</p>${details(a)}${button(link, 'View my appointment')}`)
  }
}
export function patientCancelled(a, { by, reason, link }) {
  const who = by === 'doctor' ? 'the doctor' : 'you'
  return {
    subject: `Your appointment on ${a.startIst} was cancelled`,
    html: layout('Appointment cancelled', `<p>Hello ${esc(a.patientName)},</p><p>Your appointment was cancelled by ${who}.</p>${reason ? `<p><strong>Reason:</strong> ${esc(reason)}</p>` : ''}${details(a)}<p>You can book another time whenever you like.</p>${button(link, 'Find a doctor')}`)
  }
}
export function patientNeedsRebooking(a, { options, reason, link }) {
  const list = options.length
    ? `<p>Here are some times that are free right now:</p><ul>${options.map((o) => `<li>${esc(o.startIst)} with ${esc(o.doctorName)}</li>`).join('')}</ul>`
    : '<p>There are no free times right now. We will keep looking and let you know.</p>'
  return {
    subject: 'Please choose a new time for your appointment',
    html: layout('Your appointment needs a new time', `<p>Hello ${esc(a.patientName)},</p><p>Your appointment on <strong>${esc(a.startIst)}</strong> with ${esc(a.doctorName)} can no longer go ahead.${reason ? ` Reason: ${esc(reason)}.` : ''}</p>${list}${button(link, 'Choose a new time')}`)
  }
}
export function doctorNewRequest(a, { link }) {
  return {
    subject: `New appointment request for ${a.startIst}`,
    html: layout('New appointment request', `<p>Hello ${esc(a.doctorName)},</p><p>A patient has asked for an appointment. Please confirm or cancel it.</p><table style="margin:12px 0;border-collapse:collapse;font-size:14px">${row('Patient', `${a.patientName}, ${a.age} yrs, ${a.gender}`)}${row('When (IST)', a.startIst)}${row('Reason', a.reason)}</table>${button(link, 'Open my dashboard')}`)
  }
}
export function doctorPatientCancelled(a, { reason, link }) {
  return {
    subject: `Appointment cancelled by the patient: ${a.startIst}`,
    html: layout('Patient cancelled', `<p>Hello ${esc(a.doctorName)},</p><p>${esc(a.patientName)} has cancelled the appointment. The slot is free again.</p>${reason ? `<p><strong>Reason:</strong> ${esc(reason)}</p>` : ''}${details({ ...a, patientName: null })}${button(link, 'Open my dashboard')}`)
  }
}
