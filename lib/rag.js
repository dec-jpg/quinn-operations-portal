// Automated Green / Amber / Red indicators for the five management areas.
// Every threshold lives in the rules below; a director can change them from RAG rules in the portal.
const { q } = require('./db');
const { today: todayIso, daysBetween } = require('./util');

const DEFAULTS = {
  programme: { slip_amber: 5, slip_red: 10, late_days_amber: 7, late_days_red: 28, milestones_amber: 1, milestones_red: 3 },
  commercial: { margin_amber: 8, margin_red: 4, overdue_days_amber: 1, overdue_days_red: 30, unagreed_pct_amber: 3, unagreed_pct_red: 8, notices_amber: 1, notices_red: 3 },
  safety: { audit_amber: 90, audit_red: 80, high_open_amber: 1, high_open_red: 3, overdue_amber: 1, overdue_red: 3, incidents_amber: 1, incidents_red: 3 },
  quality: { failed_amber: 1, failed_red: 1, ncr_amber: 2, ncr_red: 5, itp_slip_amber: 5, itp_slip_red: 15, inspections_amber: 3, inspections_red: 8, overdue_amber: 1, overdue_red: 3 },
  management: { overdue_actions_amber: 1, overdue_actions_red: 3, update_days_amber: 8, update_days_red: 15 },
};
const AREAS = Object.keys(DEFAULTS);

async function getRules() {
  const row = (await q("SELECT value FROM settings WHERE key = 'rag_rules'")).rows[0];
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { /* fall back to defaults */ }
  const out = {};
  for (const a of AREAS) { out[a] = { ...DEFAULTS[a] }; for (const k of Object.keys(DEFAULTS[a])) if (Number.isFinite(Number((saved[a] || {})[k])) && (saved[a] || {})[k] !== null) out[a][k] = Number(saved[a][k]); }
  return out;
}
async function setRules(input) {
  const out = {};
  for (const a of AREAS) { out[a] = {}; for (const k of Object.keys(DEFAULTS[a])) { const n = Number((input[a] || {})[k]); out[a][k] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[a][k]; } }
  await q("INSERT INTO settings (key, value) VALUES ('rag_rules', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(out)]);
  return out;
}

const NAMES = ['green', 'amber', 'red'];
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const money = n => '£' + Math.round(n).toLocaleString('en-GB');

// One area's checks. add(value, amber, red, text) flags when value reaches a threshold; addLow flags when it falls below one.
// An area with nothing recorded against it yet shows as "no data" rather than Green.
function area() {
  let level = 0, seen = false; const why = [];
  return {
    seen() { seen = true; },
    add(value, amber, red, text) { if (!isNum(value)) return; const l = value >= red ? 2 : value >= amber ? 1 : 0; if (l) { level = Math.max(level, l); why.push(text); } },
    addLow(value, amber, red, text) { if (!isNum(value)) return; const l = value < red ? 2 : value < amber ? 1 : 0; if (l) { level = Math.max(level, l); why.push(text); } },
    force(l, text) { seen = true; level = Math.max(level, l); why.push(text); },
    result() { return { s: seen ? NAMES[level] : 'none', why }; },
  };
}

// p: project row. u: latest weekly update data (or null). g: counts from the registers, actions and escalations.
function evaluate(p, u, g, rules, today) {
  const d = u ? u.data : null;
  const out = {};

  { // Programme
    const a = area(), r = rules.programme;
    if (d || g.milestones) a.seen();
    if (d && isNum(d.planned_pct) && isNum(d.actual_pct)) {
      const slip = Math.round((d.planned_pct - d.actual_pct) * 10) / 10;
      a.add(slip, r.slip_amber, r.slip_red, `${slip}% behind planned progress (planned ${d.planned_pct}%, actual ${d.actual_pct}%)`);
    }
    if (d && d.forecast_completion && p.planned_completion) {
      const late = daysBetween(p.planned_completion, d.forecast_completion);
      a.add(late, r.late_days_amber, r.late_days_red, `Forecast completion is ${plural(late, 'day')} after the planned date`);
    }
    if (g.milestones) a.add(g.milestones_late, r.milestones_amber, r.milestones_red, `${plural(g.milestones_late, 'milestone')} past ${g.milestones_late === 1 ? 'its' : 'their'} date`);
    out.programme = a.result();
  }

  { // Commercial
    const a = area(), r = rules.commercial;
    if (d) {
      a.seen();
      const value = (p.contract_value || 0) + (d.approved_variations || 0);
      if (value > 0 && isNum(d.forecast_cost)) {
        const margin = Math.round(((value - d.forecast_cost) / value) * 1000) / 10;
        a.addLow(margin, r.margin_amber, r.margin_red, `Forecast margin is ${margin}%`);
      }
      if (isNum(d.overdue_amount) && d.overdue_amount > 0) {
        const days = isNum(d.overdue_days) ? d.overdue_days : r.overdue_days_amber;
        a.add(days, r.overdue_days_amber, r.overdue_days_red, `${money(d.overdue_amount)} of payment overdue${isNum(d.overdue_days) ? ` by ${plural(days, 'day')}` : ''}`);
      }
      if (isNum(d.unagreed_value) && p.contract_value > 0) {
        const pct = Math.round((d.unagreed_value / p.contract_value) * 1000) / 10;
        a.add(pct, r.unagreed_pct_amber, r.unagreed_pct_red, `${money(d.unagreed_value)} of variations not yet agreed (${pct}% of contract value)`);
      }
      a.add(d.notices_open, r.notices_amber, r.notices_red, `${plural(d.notices_open, 'contractual notice')} open`);
    }
    out.commercial = a.result();
  }

  { // Safety
    const a = area(), r = rules.safety, s = g.safety;
    if (s.total || d) a.seen();
    if (isNum(s.audit_score)) a.addLow(s.audit_score, r.audit_amber, r.audit_red, `Last site audit scored ${s.audit_score}%`);
    a.add(s.high_open, r.high_open_amber, r.high_open_red, `${plural(s.high_open, 'high-risk item')} open`);
    a.add(s.overdue, r.overdue_amber, r.overdue_red, `${plural(s.overdue, 'corrective action')} overdue`);
    if (d) a.add(d.incidents, r.incidents_amber, r.incidents_red, `${plural(d.incidents, 'incident')} reported this week`);
    out.safety = a.result();
  }

  { // Quality
    const a = area(), r = rules.quality, s = g.quality;
    if (s.total || d) a.seen();
    a.add(s.failed, r.failed_amber, r.failed_red, `${plural(s.failed, 'failed hold point or inspection', 'failed hold points or inspections')} not yet closed`);
    a.add(s.ncr_open, r.ncr_amber, r.ncr_red, `${plural(s.ncr_open, 'non-conformance report')} open`);
    a.add(s.overdue, r.overdue_amber, r.overdue_red, `${plural(s.overdue, 'quality item')} overdue`);
    if (d && isNum(d.itp_planned_pct) && isNum(d.itp_actual_pct)) {
      const slip = Math.round((d.itp_planned_pct - d.itp_actual_pct) * 10) / 10;
      a.add(slip, r.itp_slip_amber, r.itp_slip_red, `Inspection and Test Plan is ${slip}% behind`);
    }
    if (d) a.add(d.inspections_due, r.inspections_amber, r.inspections_red, `${plural(d.inspections_due, 'inspection')} outstanding`);
    out.quality = a.result();
  }

  { // Management actions
    const a = area(), r = rules.management;
    if (g.actions_total || u) a.seen();
    a.add(g.actions_overdue, r.overdue_actions_amber, r.overdue_actions_red, `${plural(g.actions_overdue, 'action')} overdue`);
    if (p.status === 'live') {
      if (u) { const days = daysBetween(u.week_ending, today); a.add(days, r.update_days_amber, r.update_days_red, `Last weekly update was for week ending ${u.week_ending.split('-').reverse().join('/')}`); }
      else { const days = daysBetween(String(p.created_at instanceof Date ? p.created_at.toISOString() : p.created_at).slice(0, 10), today); if (days >= r.update_days_amber) { a.seen(); a.add(days, r.update_days_amber, r.update_days_red, 'No weekly update received yet'); } }
    }
    if (g.escalations_waiting) a.force(2, `${plural(g.escalations_waiting, 'escalation')} waiting for a response`);
    out.management = a.result();
  }
  return out;
}

// Live indicators for a set of projects, worked out together.
async function forProjects(projects, today = todayIso()) {
  if (!projects.length) return {};
  const ids = projects.map(p => p.id);
  const [rules, updates, reg, audits, acts, escs, ms] = await Promise.all([
    getRules(),
    q('SELECT DISTINCT ON (project_id) project_id, week_ending, data, submitted_name, submitted_at FROM weekly_updates WHERE project_id = ANY($1) ORDER BY project_id, week_ending DESC', [ids]),
    q(`SELECT project_id, register, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status <> 'closed' AND severity = 'high') AS high_open,
        COUNT(*) FILTER (WHERE status <> 'closed' AND due_on < $2) AS overdue,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE type = 'ncr' AND status <> 'closed') AS ncr_open,
        COUNT(*) FILTER (WHERE status <> 'closed') AS open
      FROM register_items WHERE project_id = ANY($1) GROUP BY 1, 2`, [ids, today]),
    q("SELECT DISTINCT ON (project_id) project_id, score, raised_on FROM register_items WHERE project_id = ANY($1) AND type = 'audit' AND score IS NOT NULL ORDER BY project_id, raised_on DESC, id DESC", [ids]),
    q("SELECT project_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'open') AS open, COUNT(*) FILTER (WHERE status = 'open' AND due_on < $2) AS overdue FROM actions WHERE project_id = ANY($1) GROUP BY 1", [ids, today]),
    q('SELECT project_id, COUNT(*) AS waiting FROM escalations WHERE project_id = ANY($1) AND acknowledged_at IS NULL AND closed_at IS NULL GROUP BY 1', [ids]),
    q('SELECT project_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE actual_on IS NULL AND COALESCE(forecast_on, planned_on) < $2) AS late FROM milestones WHERE project_id = ANY($1) GROUP BY 1', [ids, today]),
  ]);
  const by = (rows, id) => rows.find(r => r.project_id === id);
  const out = {};
  for (const p of projects) {
    const empty = { total: 0, high_open: 0, overdue: 0, failed: 0, ncr_open: 0, open: 0 };
    const regOf = name => reg.rows.find(r => r.project_id === p.id && r.register === name) || empty;
    const audit = by(audits.rows, p.id), a = by(acts.rows, p.id), e = by(escs.rows, p.id), m = by(ms.rows, p.id);
    const g = {
      safety: { ...regOf('safety'), audit_score: audit ? audit.score : null, audit_on: audit ? audit.raised_on : null },
      quality: regOf('quality'),
      actions_total: a ? a.total : 0, actions_open: a ? a.open : 0, actions_overdue: a ? a.overdue : 0,
      escalations_waiting: e ? e.waiting : 0,
      milestones: m ? m.total : 0, milestones_late: m ? m.late : 0,
    };
    const u = by(updates.rows, p.id) || null;
    out[p.id] = { rag: evaluate(p, u, g, rules, today), latest: u, counts: g };
  }
  return out;
}

module.exports = { DEFAULTS, AREAS, getRules, setRules, forProjects };
