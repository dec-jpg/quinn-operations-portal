const clean = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? null : String(v).trim().slice(0, max)) || null;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T12:00:00Z'));
const date = v => (isDate(v) ? v : null);
const num = (v, min = 0, max = 1e12) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null; };

// Dates are worked in Europe/London, as plain YYYY-MM-DD strings.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
// Reporting weeks end on a Friday: the Friday on or after the given day.
const weekEnding = (iso = today()) => { const dow = new Date(iso + 'T12:00:00Z').getUTCDay(); return addDays(iso, (5 - dow + 7) % 7); };

module.exports = { clean, isDate, date, num, today, addDays, daysBetween, weekEnding };
