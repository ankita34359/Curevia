export const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`
export const initials = (name = '') => name.replace(/^dr\.?\s+/i, '').split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('')
export const DEPARTMENT_ICONS = {
  stethoscope: '🩺', heart: '❤️', baby: '👶', brain: '🧠', bone: '🦴', eye: '👁️', tooth: '🦷', lungs: '🫁', ear: '👂', skin: '🧴', pill: '💊', female: '🌸'
}
export const iconFor = (key) => DEPARTMENT_ICONS[key] || DEPARTMENT_ICONS.stethoscope
export const WEEKDAYS = [
  { n: 1, name: 'Monday' }, { n: 2, name: 'Tuesday' }, { n: 3, name: 'Wednesday' }, { n: 4, name: 'Thursday' },
  { n: 5, name: 'Friday' }, { n: 6, name: 'Saturday' }, { n: 0, name: 'Sunday' }
]
