// The three viaSocket embed slots. Action ids were read from viaSocket's live catalog (catalog.versions),
// never typed from memory; scripts/viasocket-check.mjs re-checks them on every test run.
export const SLOT_NAMES = ['appointments_sheet', 'email_sender', 'slack_alert']

export const SLOTS = {
  appointments_sheet: {
    label: 'Google Sheet: appointment log',
    slug: 'google-sheets',
    appName: 'Google Sheets',
    actionName: 'Add New Row to Sheet',
    actionId: 'rowxsuumuqrt', // google-sheets, version V66
    channel: 'sheet',
    description: 'Every booking and every status change adds one row to a Google Sheet.',
    steps: [
      'Choose the spreadsheet and the sheet tab you want to use. Put the column titles from the sample below in row 1.',
      'Map each column to the matching field from the incoming data (appointment_id, patient_name, ...).',
      'Press Publish.'
    ],
    sample: {
      appointment_id: 1, patient_name: 'Asha Fake', age: 34, gender: 'female', phone: '+91 90000 00000', email: 'asha@example.com',
      reason: 'Fake: routine check-up', doctor: 'Dr. Anita Rao', department: 'General Medicine', date: '24 Oct 2026', time: '10:30 AM',
      status: 'pending', event: 'booked', at: '22 Oct 2026, 9:15 AM'
    }
  },
  email_sender: {
    label: 'Gmail: email sender',
    // viaSocket bug: the catalog returns this app as slug "gmail", but the slug-to-id lookup (catalog.serviceIdFor) and the slug service
    // both fail for it. So Gmail is identified by the service_id the catalog search returns for the app named "Gmail".
    serviceId: 'rowo0bqrhj5g',
    appName: 'Gmail',
    actionName: 'Send Email',
    actionId: 'rowogelpy0h6', // gmail, version V55
    channel: 'email',
    description: 'Curevia writes every email (subject and HTML body); Gmail sends it.',
    steps: [
      'Connect the Gmail account that should send the emails.',
      'Map To, Subject and Message body to the incoming fields to, subject and body. The body is HTML.',
      'Press Publish.'
    ],
    sample: { to: 'patient@example.com', subject: 'Your appointment is confirmed', body: '<p>Hello, your appointment is confirmed.</p>' }
  },
  slack_alert: {
    label: 'Slack: #curevia-alerts',
    slug: 'slack',
    appName: 'Slack',
    actionName: 'Send Message',
    actionId: 'row1jrbor', // slack, version V107
    channel: 'slack',
    description: 'Short alerts for the admin, sent to the #curevia-alerts channel.',
    steps: [
      'Connect Slack and choose the channel #curevia-alerts as the destination.',
      'Map the message text to the incoming field text.',
      'Press Publish.'
    ],
    sample: { text: 'Curevia alert: an appointment has been waiting for the doctor for 6 hours.' }
  }
}
