// RFC 4180 CSV. Cells that start with = + - @ are prefixed so spreadsheets do not run them as formulas.
export function toCsv(rows, columns) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns.map((c) => cell(c.header)).join(','), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(','))].join('\r\n') + '\r\n'
}
