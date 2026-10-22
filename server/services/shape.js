import { formatIst, formatIstDate, formatIstTime, istDate } from '../lib/time.js'

// What the browser sees of an appointment. Times are UTC plus ready-made India-time text.
export const shapeAppointment = (a) => ({
  id: a.id,
  status: a.status,
  startUtc: a.start_utc,
  endUtc: a.end_utc,
  startIst: formatIst(a.start_utc),
  dateIst: formatIstDate(a.start_utc),
  timeIst: formatIstTime(a.start_utc),
  dayIst: istDate(a.start_utc),
  doctorId: a.doctor_id,
  doctorName: a.doctor_name,
  department: a.department,
  patientName: a.patient_name,
  age: a.age,
  gender: a.gender,
  phone: a.phone,
  email: a.email,
  reason: a.reason,
  cancelReason: a.cancel_reason,
  createdAt: a.created_at
})
