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
