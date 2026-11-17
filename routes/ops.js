// Portal API. Roles: owner (portal support), admin (director: everything, including users and RAG rules),
// manager (Contracts Manager: their own projects only), viewer (read only, every project).
const express = require('express');
const { q } = require('../lib/db');
const { requireUser, hash } = require('../lib/auth');
const { clean, date, num, today, addDays, weekEnding } = require('../lib/util');
const rag = require('../lib/rag');
const mail = require('../lib/mail');

const r = express.Router();
const any = requireUser();
const editor = requireUser('manager');
const admin = requireUser('admin');

const seesAll = u => u.role !== 'manager';
const isAdmin = u => u.role === 'admin' || u.role === 'owner';
const baseUrl = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const fail = (status, message) => Object.assign(new Error(message), { status });
r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ---------- audit trail ----------
async function log(req, action, entity, entityId, projectId, summary, detail) {
  await q('INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, project_id, summary, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [req.user.id, req.user.name, action, entity, entityId || null, projectId || null, summary || null, detail ? JSON.stringify(detail) : null]);
}
// What changed between two rows, for the audit trail.
function diff(before, after, keys) {
  const out = {};
  for (const k of keys) if (String(before[k] ?? '') !== String(after[k] ?? '')) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  return Object.keys(out).length ? out : null;
}

// ---------- projects a login may see or change ----------
const PROJECT_SQL = `SELECT p.*, u.name AS cm_name FROM projects p LEFT JOIN users u ON u.id = p.cm_id`;
async function visibleProjects(user, liveOnly) {
  const rows = (await q(`${PROJECT_SQL} WHERE ($1 OR p.cm_id = $2) ${liveOnly ? "AND p.status = 'live'" : ''} ORDER BY p.status = 'live' DESC, p.ref NULLS LAST, p.name`, [seesAll(user), user.id])).rows;
  return rows;
}
async function getProject(req, id, write) {
  const p = (await q(`${PROJECT_SQL} WHERE p.id = $1`, [Number(id) || 0])).rows[0];
  if (!p || (!seesAll(req.user) && p.cm_id !== req.user.id)) throw fail(404, 'Project not found.');
  if (write && !isAdmin(req.user) && p.cm_id !== req.user.id) throw fail(403, 'Only the Contracts Manager for this project can change it.');
  return p;
}
// Keeps the indicators stored with the latest weekly update in step when a register, action or milestone changes.
async function resnap(projectId) {
  if (!projectId) return;
  const p = (await q('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
  if (!p) return;
  const live = (await rag.forProjects([p]))[p.id];
  await q('UPDATE weekly_updates SET rag = $1 WHERE id = (SELECT id FROM weekly_updates WHERE project_id = $2 ORDER BY week_ending DESC LIMIT 1)', [JSON.stringify(live.rag), projectId]);
}

// ---------- dashboard ----------
r.get('/overview', any, async (req, res) => {
  const projects = await visibleProjects(req.user, true);
  const live = await rag.forProjects(projects);
  const week = weekEnding();
  const ids = projects.map(p => p.id);
  const escalations = (await q(`SELECT e.*, p.name AS project_name, p.ref AS project_ref FROM escalations e JOIN projects p ON p.id = e.project_id
    WHERE e.closed_at IS NULL AND e.project_id = ANY($1) ORDER BY e.raised_at DESC`, [ids])).rows;
  const overdue = (await q("SELECT COUNT(*) AS n FROM actions WHERE status = 'open' AND due_on < $1 AND (project_id = ANY($2) OR (project_id IS NULL AND $3))", [today(), ids, seesAll(req.user)])).rows[0].n;
  res.json({
    week, escalations, overdue_actions: overdue,
    projects: projects.map(p => { const l = live[p.id]; return { ...p, rag: l.rag, last_week: l.latest ? l.latest.week_ending : null, update_in: !!(l.latest && l.latest.week_ending === week), counts: l.counts }; }),
  });
});

// ---------- people ----------
r.get('/people', any, async (req, res) => {
  res.json({ rows: (await q("SELECT id, name, role, job_title FROM users WHERE active AND role <> 'owner' ORDER BY name")).rows });
});

// ---------- project register ----------
r.get('/projects', any, async (req, res) => res.json({ rows: await visibleProjects(req.user) }));

function projectFields(b) {
  return [clean(b.ref, 30), clean(b.name, 160), clean(b.client, 160), clean(b.location, 200), clean(b.sector, 80), Number(b.cm_id) || null, num(b.contract_value), date(b.start_on), date(b.planned_completion),
    ['live', 'on hold', 'complete'].includes(b.status) ? b.status : 'live', clean(b.notes, 2000)];
}
const PROJECT_KEYS = ['ref', 'name', 'client', 'location', 'sector', 'cm_id', 'contract_value', 'start_on', 'planned_completion', 'status', 'notes'];

r.post('/projects', admin, async (req, res) => {
  const f = projectFields(req.body || {});
  if (!f[1]) throw fail(400, 'Give the project a name.');
  if (!f[5]) throw fail(400, 'Choose the Contracts Manager for this project.');
  const row = (await q(`INSERT INTO projects (ref, name, client, location, sector, cm_id, contract_value, start_on, planned_completion, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, f)).rows[0];
  await log(req, 'created', 'project', row.id, row.id, `Project added: ${row.name}`);
  res.json({ row });
});

r.put('/projects/:id', admin, async (req, res) => {
  const before = await getProject(req, req.params.id, true);
  const f = projectFields(req.body || {});
  if (!f[1]) throw fail(400, 'Give the project a name.');
  if (!f[5]) throw fail(400, 'Choose the Contracts Manager for this project.');
  const row = (await q(`UPDATE projects SET ref=$1, name=$2, client=$3, location=$4, sector=$5, cm_id=$6, contract_value=$7, start_on=$8, planned_completion=$9, status=$10, notes=$11 WHERE id=$12 RETURNING *`, [...f, before.id])).rows[0];
  await log(req, 'updated', 'project', row.id, row.id, `Project details changed: ${row.name}`, diff(before, row, PROJECT_KEYS));
  await resnap(row.id);
  res.json({ row });
});

r.get('/projects/:id', any, async (req, res) => {
  const p = await getProject(req, req.params.id);
  const [live, milestones, updates, items, actions, escalations, history] = await Promise.all([
    rag.forProjects([p]),
    q('SELECT * FROM milestones WHERE project_id = $1 ORDER BY COALESCE(planned_on, forecast_on) NULLS LAST, id', [p.id]),
    q('SELECT id, week_ending, data, rag, submitted_name, submitted_at, updated_at FROM weekly_updates WHERE project_id = $1 ORDER BY week_ending DESC LIMIT 52', [p.id]),
    q('SELECT * FROM register_items WHERE project_id = $1 ORDER BY raised_on DESC, id DESC', [p.id]),
    q("SELECT * FROM actions WHERE project_id = $1 ORDER BY status = 'open' DESC, due_on NULLS LAST, id DESC", [p.id]),
    q('SELECT * FROM escalations WHERE project_id = $1 ORDER BY raised_at DESC', [p.id]),
    q('SELECT id, at, user_name, action, entity, summary, detail FROM audit_log WHERE project_id = $1 ORDER BY at DESC LIMIT 200', [p.id]),
  ]);
  res.json({ project: p, rag: live[p.id].rag, counts: live[p.id].counts, week: weekEnding(), can_edit: req.user.role !== 'viewer' && (isAdmin(req.user) || p.cm_id === req.user.id),
    milestones: milestones.rows, updates: updates.rows, items: items.rows, actions: actions.rows, escalations: escalations.rows, history: history.rows });
});

// ---------- milestones ----------
const msFields = b => [clean(b.name, 160), date(b.planned_on), date(b.forecast_on), date(b.actual_on)];
r.post('/projects/:id/milestones', editor, async (req, res) => {
  const p = await getProject(req, req.params.id, true);
  const f = msFields(req.body || {});
  if (!f[0]) throw fail(400, 'Give the milestone a name.');
  const row = (await q('INSERT INTO milestones (project_id, name, planned_on, forecast_on, actual_on) VALUES ($1,$2,$3,$4,$5) RETURNING *', [p.id, ...f])).rows[0];
  await log(req, 'created', 'milestone', row.id, p.id, `Milestone added: ${row.name}`);
  await resnap(p.id);
  res.json({ row });
});
r.put('/milestones/:id', editor, async (req, res) => {
  const before = (await q('SELECT * FROM milestones WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
  if (!before) throw fail(404, 'Not found.');
  const p = await getProject(req, before.project_id, true);
  const f = msFields(req.body || {});
  if (!f[0]) throw fail(400, 'Give the milestone a name.');
  const row = (await q('UPDATE milestones SET name=$1, planned_on=$2, forecast_on=$3, actual_on=$4 WHERE id=$5 RETURNING *', [...f, before.id])).rows[0];
  await log(req, 'updated', 'milestone', row.id, p.id, `Milestone changed: ${row.name}`, diff(before, row, ['name', 'planned_on', 'forecast_on', 'actual_on']));
  await resnap(p.id);
  res.json({ row });
});
r.delete('/milestones/:id', editor, async (req, res) => {
  const before = (await q('SELECT * FROM milestones WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
  if (!before) throw fail(404, 'Not found.');
  const p = await getProject(req, before.project_id, true);
  await q('DELETE FROM milestones WHERE id = $1', [before.id]);
  await log(req, 'removed', 'milestone', before.id, p.id, `Milestone removed: ${before.name}`, before);
  await resnap(p.id);
  res.json({ ok: true });
});

// ---------- weekly updates ----------
const pct = v => num(v, 0, 100);
const whole = v => { const n = num(v, 0, 100000); return n == null ? null : Math.round(n); };
const text = v => clean(v, 3000);
const UPDATE_FIELDS = {
  planned_pct: pct, actual_pct: pct, forecast_completion: date, delay: text, recovery: text,
  approved_variations: num, applied: num, certified: num, paid: num, overdue_amount: num, overdue_days: whole, unagreed_n: whole, unagreed_value: num, notices_open: whole, forecast_cost: num, commercial_risk: text,
  audit_on: date, audit_score: pct, incidents: whole, near_misses: whole, critical_activities: text, safety_note: text,
  itp_planned_pct: pct, itp_actual_pct: pct, inspections_due: whole, tests_outstanding: whole, handover_outstanding: whole, quality_risk: text,
  summary: text, issues: text, decision: text,
};
// Figures that carry forward into next week's form so the Contracts Manager only changes what moved.
const CARRY = ['forecast_completion', 'approved_variations', 'applied', 'certified', 'paid', 'unagreed_n', 'unagreed_value', 'notices_open', 'forecast_cost', 'inspections_due', 'tests_outstanding', 'handover_outstanding'];

r.get('/weekly', any, async (req, res) => {
  const projects = await visibleProjects(req.user, true);
  const week = date(req.query.week) || weekEnding();
  const rows = (await q('SELECT project_id, submitted_name, updated_at FROM weekly_updates WHERE week_ending = $1 AND project_id = ANY($2)', [week, projects.map(p => p.id)])).rows;
  res.json({ week, this_week: weekEnding(), projects: projects.map(p => ({ id: p.id, ref: p.ref, name: p.name, cm_id: p.cm_id, cm_name: p.cm_name, update: rows.find(x => x.project_id === p.id) || null,
    can_edit: req.user.role !== 'viewer' && (isAdmin(req.user) || p.cm_id === req.user.id) })) });
});

r.get('/projects/:id/update', any, async (req, res) => {
  const p = await getProject(req, req.params.id);
  const week = weekEnding(date(req.query.week) || today());
  const existing = (await q('SELECT * FROM weekly_updates WHERE project_id = $1 AND week_ending = $2', [p.id, week])).rows[0] || null;
  const previous = (await q('SELECT week_ending, data FROM weekly_updates WHERE project_id = $1 AND week_ending < $2 ORDER BY week_ending DESC LIMIT 1', [p.id, week])).rows[0] || null;
  let data = existing ? existing.data : {};
  if (!existing && previous) for (const k of CARRY) if (previous.data[k] != null) data[k] = previous.data[k];
  res.json({ project: p, week, this_week: weekEnding(), existing: existing ? { submitted_name: existing.submitted_name, updated_at: existing.updated_at } : null, previous, data });
});

r.put('/projects/:id/update', editor, async (req, res) => {
  const p = await getProject(req, req.params.id, true);
  const b = req.body || {};
  const week = weekEnding(date(b.week_ending) || today());
  if (week > weekEnding()) throw fail(400, 'That week has not started yet.');
  const data = {};
  for (const [k, parse] of Object.entries(UPDATE_FIELDS)) { const v = parse((b.data || {})[k]); if (v != null) data[k] = v; }
  if (data.planned_pct == null || data.actual_pct == null) throw fail(400, 'Enter planned and actual progress.');
  const before = (await q('SELECT id, data FROM weekly_updates WHERE project_id = $1 AND week_ending = $2', [p.id, week])).rows[0];
  const row = (await q(`INSERT INTO weekly_updates (project_id, week_ending, data, submitted_by, submitted_name) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (project_id, week_ending) DO UPDATE SET data = EXCLUDED.data, submitted_by = EXCLUDED.submitted_by, submitted_name = EXCLUDED.submitted_name, updated_at = NOW() RETURNING id`,
    [p.id, week, JSON.stringify(data), req.user.id, req.user.name])).rows[0];
  // A site audit entered on the form goes onto the safety register, once per audit date.
  if (data.audit_on && data.audit_score != null) {
    const have = (await q("SELECT id FROM register_items WHERE project_id = $1 AND type = 'audit' AND raised_on = $2", [p.id, data.audit_on])).rows[0];
    if (have) await q('UPDATE register_items SET score = $1 WHERE id = $2', [data.audit_score, have.id]);
    else await q(`INSERT INTO register_items (project_id, register, type, title, severity, status, score, raised_on, closed_on, created_by) VALUES ($1,'safety','audit','Site safety audit','low','closed',$2,$3,$3,$4)`,
      [p.id, data.audit_score, data.audit_on, req.user.name]);
  }
  const wk = week.split('-').reverse().join('/');
  await log(req, before ? 'updated' : 'submitted', 'weekly update', row.id, p.id, `Weekly update ${before ? 'changed' : 'submitted'} for week ending ${wk}`, before ? diff(before.data, data, Object.keys(UPDATE_FIELDS)) : null);
  // Store the indicators as they stand with this update, for the trend. (Only the latest week tracks later register changes.)
  const live = (await rag.forProjects([p]))[p.id];
  const latest = (await q('SELECT id FROM weekly_updates WHERE project_id = $1 ORDER BY week_ending DESC LIMIT 1', [p.id])).rows[0];
  if (latest.id === row.id) await q('UPDATE weekly_updates SET rag = $1 WHERE id = $2', [JSON.stringify(live.rag), row.id]);
  else {
    const snap = (await q('SELECT rag FROM weekly_updates WHERE id = $1', [row.id])).rows[0].rag;
    if (!snap || !snap.programme) await q('UPDATE weekly_updates SET rag = $1 WHERE id = $2', [JSON.stringify(live.rag), row.id]);
  }
  res.json({ ok: true, week, rag: live.rag });
});

// ---------- safety and quality registers ----------
const TYPES = {
  safety: ['audit', 'finding', 'incident', 'near_miss', 'temporary_works', 'critical_activity'],
  quality: ['inspection', 'hold_point', 'ncr', 'defect', 'test', 'handover_doc'],
};
const CAN_FAIL = ['inspection', 'hold_point', 'test'];
const ITEM_SQL = `SELECT i.*, p.name AS project_name, p.ref AS project_ref FROM register_items i JOIN projects p ON p.id = i.project_id`;

r.get('/items', any, async (req, res) => {
  const register = req.query.register === 'quality' ? 'quality' : 'safety';
  const rows = (await q(`${ITEM_SQL} WHERE i.register = $1 AND ($2 OR p.cm_id = $3) ORDER BY i.status = 'closed', i.raised_on DESC, i.id DESC LIMIT 1000`, [register, seesAll(req.user), req.user.id])).rows;
  res.json({ rows });
});

function itemFields(b, register) {
  const type = TYPES[register].includes(b.type) ? b.type : null;
  let status = ['open', 'closed', 'failed'].includes(b.status) ? b.status : 'open';
  if (status === 'failed' && !CAN_FAIL.includes(type)) status = 'open';
  if (type === 'audit') status = 'closed';
  return { type, title: clean(b.title, 200), detail: clean(b.detail, 3000), severity: ['low', 'medium', 'high'].includes(b.severity) ? b.severity : 'low', status,
    score: type === 'audit' ? num(b.score, 0, 100) : null, raised_on: date(b.raised_on) || today(), due_on: date(b.due_on), owner: clean(b.owner, 120), close_note: clean(b.close_note, 1000) };
}
const ITEM_KEYS = ['type', 'title', 'detail', 'severity', 'status', 'score', 'raised_on', 'due_on', 'owner', 'close_note', 'closed_on'];
const LABEL = { audit: 'Site audit', finding: 'Audit finding', incident: 'Incident', near_miss: 'Near miss', temporary_works: 'Temporary works', critical_activity: 'Critical activity',
  inspection: 'Inspection', hold_point: 'Hold point', ncr: 'Non-conformance report', defect: 'Defect or rework', test: 'Test or certificate', handover_doc: 'Handover document' };

async function raise(req, p, kind, title, detail, itemId) {
  const e = (await q('INSERT INTO escalations (project_id, kind, title, detail, item_id, raised_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [p.id, kind, title, detail || null, itemId || null, req.user.name])).rows[0];
  await log(req, 'raised', 'escalation', e.id, p.id, `Escalated: ${kind}: ${title}`);
  mail.escalation(e, p, baseUrl(req)).catch(() => {});
  return e;
}
// Serious incidents and failed hold points go straight to the director rather than waiting for the weekly report.
const mustEscalate = i => (i.type === 'incident' && i.severity === 'high') || (i.type === 'hold_point' && i.status === 'failed');

r.post('/items', editor, async (req, res) => {
  const b = req.body || {};
  const register = b.register === 'quality' ? 'quality' : 'safety';
  const p = await getProject(req, b.project_id, true);
  const f = itemFields(b, register);
  if (!f.type) throw fail(400, 'Choose what kind of entry this is.');
  if (!f.title) throw fail(400, 'Give the entry a short title.');
  if (f.type === 'audit' && f.score == null) throw fail(400, 'Enter the audit score.');
  const row = (await q(`INSERT INTO register_items (project_id, register, type, title, detail, severity, status, score, raised_on, due_on, closed_on, owner, close_note, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [p.id, register, f.type, f.title, f.detail, f.severity, f.status, f.score, f.raised_on, f.due_on, f.status === 'closed' ? (f.type === 'audit' ? f.raised_on : today()) : null, f.owner, f.close_note, req.user.name])).rows[0];
  await log(req, 'created', `${register} register`, row.id, p.id, `${LABEL[row.type]} recorded: ${row.title}`);
  let escalated = false;
  if (mustEscalate(row)) { await raise(req, p, row.type === 'incident' ? 'Safety incident' : 'Failed hold point', row.title, row.detail, row.id); escalated = true; }
  await resnap(p.id);
  res.json({ row, escalated });
});

r.put('/items/:id', editor, async (req, res) => {
  const before = (await q('SELECT * FROM register_items WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
  if (!before) throw fail(404, 'Not found.');
  const p = await getProject(req, before.project_id, true);
  const f = itemFields(req.body || {}, before.register);
  if (!f.type) throw fail(400, 'Choose what kind of entry this is.');
  if (!f.title) throw fail(400, 'Give the entry a short title.');
  const closedOn = f.status === 'closed' ? (before.closed_on || (f.type === 'audit' ? f.raised_on : today())) : null;
  const row = (await q(`UPDATE register_items SET type=$1, title=$2, detail=$3, severity=$4, status=$5, score=$6, raised_on=$7, due_on=$8, closed_on=$9, owner=$10, close_note=$11 WHERE id=$12 RETURNING *`,
    [f.type, f.title, f.detail, f.severity, f.status, f.score, f.raised_on, f.due_on, closedOn, f.owner, f.close_note, before.id])).rows[0];
  const verb = before.status !== 'closed' && row.status === 'closed' ? 'closed' : 'updated';
  await log(req, verb, `${before.register} register`, row.id, p.id, `${LABEL[row.type]} ${verb}: ${row.title}`, diff(before, row, ITEM_KEYS));
  let escalated = false;
  if (mustEscalate(row) && !mustEscalate(before)) { await raise(req, p, row.type === 'incident' ? 'Safety incident' : 'Failed hold point', row.title, row.detail, row.id); escalated = true; }
  await resnap(p.id);
  res.json({ row, escalated });
});

// ---------- central action tracker ----------
const AREAS = ['programme', 'commercial', 'safety', 'quality', 'management'];
const ACTION_SQL = `SELECT a.*, p.name AS project_name, p.ref AS project_ref, p.cm_id FROM actions a LEFT JOIN projects p ON p.id = a.project_id`;
const ACTION_KEYS = ['area', 'title', 'detail', 'owner_name', 'due_on', 'status', 'close_note', 'needs_director'];

r.get('/actions', any, async (req, res) => {
  // Contracts Managers see actions on their projects and any action that is theirs to do.
  const rows = (await q(`${ACTION_SQL} WHERE ($1 OR p.cm_id = $2 OR a.owner_id = $2) ORDER BY a.status = 'open' DESC, a.due_on NULLS LAST, a.id DESC LIMIT 2000`, [seesAll(req.user), req.user.id])).rows;
  res.json({ rows, today: today() });
});

async function actionFields(b) {
  const owner = b.owner_id ? (await q('SELECT id, name FROM users WHERE id = $1 AND active', [Number(b.owner_id) || 0])).rows[0] : null;
  return { area: AREAS.includes(b.area) ? b.area : 'management', title: clean(b.title, 200), detail: clean(b.detail, 3000), owner_id: owner ? owner.id : null, owner_name: owner ? owner.name : clean(b.owner_name, 120),
    due_on: date(b.due_on), status: b.status === 'done' ? 'done' : 'open', close_note: clean(b.close_note, 1000), needs_director: !!b.needs_director };
}

r.post('/actions', editor, async (req, res) => {
  const b = req.body || {};
  let p = null;
  if (b.project_id) p = await getProject(req, b.project_id, true);
  else if (!isAdmin(req.user)) throw fail(400, 'Choose the project this action belongs to.');
  const f = await actionFields(b);
  if (!f.title) throw fail(400, 'Say what the action is.');
  if (!f.owner_name) throw fail(400, 'Choose who is responsible for the action.');
  if (!f.due_on) throw fail(400, 'Give the action a target date.');
  const row = (await q(`INSERT INTO actions (project_id, area, title, detail, owner_id, owner_name, due_on, needs_director, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [p ? p.id : null, f.area, f.title, f.detail, f.owner_id, f.owner_name, f.due_on, f.needs_director, req.user.name])).rows[0];
  await log(req, 'created', 'action', row.id, row.project_id, `Action for ${row.owner_name}, due ${row.due_on.split('-').reverse().join('/')}: ${row.title}`);
  await resnap(row.project_id);
  res.json({ row });
});

r.put('/actions/:id', editor, async (req, res) => {
  const before = (await q(`${ACTION_SQL} WHERE a.id = $1`, [Number(req.params.id) || 0])).rows[0];
  if (!before) throw fail(404, 'Not found.');
  // The director, the project's Contracts Manager and the action's owner can update it.
  if (!isAdmin(req.user) && before.cm_id !== req.user.id && before.owner_id !== req.user.id) throw fail(403, 'This action is not yours to change.');
  const f = await actionFields(req.body || {});
  if (!f.title || !f.owner_name || !f.due_on) throw fail(400, 'An action needs a title, someone responsible and a target date.');
  const closedOn = f.status === 'done' ? (before.closed_on || today()) : null;
  const row = (await q(`UPDATE actions SET area=$1, title=$2, detail=$3, owner_id=$4, owner_name=$5, due_on=$6, status=$7, closed_on=$8, close_note=$9, needs_director=$10 WHERE id=$11 RETURNING *`,
    [f.area, f.title, f.detail, f.owner_id, f.owner_name, f.due_on, f.status, closedOn, f.close_note, f.needs_director, before.id])).rows[0];
  const verb = before.status === 'open' && row.status === 'done' ? 'completed' : before.status === 'done' && row.status === 'open' ? 'reopened' : 'updated';
  await log(req, verb, 'action', row.id, row.project_id, `Action ${verb}: ${row.title}`, diff(before, row, ACTION_KEYS));
  await resnap(row.project_id);
  res.json({ row });
});

// ---------- escalations ----------
const KINDS = ['Safety incident', 'Failed hold point', 'Urgent contractual matter', 'Other urgent matter'];
r.get('/escalations', any, async (req, res) => {
  const rows = (await q(`SELECT e.*, p.name AS project_name, p.ref AS project_ref FROM escalations e JOIN projects p ON p.id = e.project_id
    WHERE ($1 OR p.cm_id = $2) ORDER BY e.closed_at IS NOT NULL, e.raised_at DESC LIMIT 500`, [seesAll(req.user), req.user.id])).rows;
  res.json({ rows, kinds: KINDS, email: mail.configured() });
});
r.post('/escalations', editor, async (req, res) => {
  const b = req.body || {};
  const p = await getProject(req, b.project_id, true);
  const title = clean(b.title, 200);
  if (!title) throw fail(400, 'Say what has happened in a line.');
  const row = await raise(req, p, KINDS.includes(b.kind) ? b.kind : 'Other urgent matter', title, clean(b.detail, 3000));
  await resnap(p.id);
  res.json({ row });
});
r.put('/escalations/:id', admin, async (req, res) => {
  const before = (await q('SELECT * FROM escalations WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
  if (!before) throw fail(404, 'Not found.');
  const b = req.body || {};
  const response = clean(b.response, 3000) || before.response;
  const row = (await q(`UPDATE escalations SET acknowledged_by = COALESCE(acknowledged_by, $1), acknowledged_at = COALESCE(acknowledged_at, NOW()), response = $2,
    closed_at = CASE WHEN $3 THEN COALESCE(closed_at, NOW()) ELSE closed_at END WHERE id = $4 RETURNING *`, [req.user.name, response, !!b.close, before.id])).rows[0];
  await log(req, b.close ? 'closed' : 'acknowledged', 'escalation', row.id, row.project_id, `Escalation ${b.close ? 'closed' : 'acknowledged'}: ${row.title}`, response !== before.response ? { response } : null);
  await resnap(row.project_id);
  res.json({ row });
});

// ---------- weekly executive summary ----------
r.get('/report', any, async (req, res) => {
  const thisWeek = weekEnding();
  const week = weekEnding(date(req.query.week) || today());
  const projects = await visibleProjects(req.user, true);
  const ids = projects.map(p => p.id);
  const current = week === thisWeek;
  const live = current ? await rag.forProjects(projects) : {};
  const updates = (await q('SELECT project_id, data, rag, submitted_name, updated_at FROM weekly_updates WHERE week_ending = $1 AND project_id = ANY($2)', [week, ids])).rows;
  const weeks = (await q('SELECT DISTINCT week_ending FROM weekly_updates WHERE project_id = ANY($1) ORDER BY week_ending DESC LIMIT 26', [ids])).rows.map(x => x.week_ending);
  if (!weeks.includes(thisWeek)) weeks.unshift(thisWeek);
  const out = { week, this_week: thisWeek, current, weeks, generated_at: new Date().toISOString(),
    projects: projects.map(p => { const u = updates.find(x => x.project_id === p.id) || null; return { id: p.id, ref: p.ref, name: p.name, cm_name: p.cm_name, update: u ? { data: u.data, submitted_name: u.submitted_name, updated_at: u.updated_at } : null,
      rag: current ? live[p.id].rag : (u && u.rag && u.rag.programme ? u.rag : null) }; }) };
  if (current) {
    const t = today();
    const lists = await Promise.all([
      q(`${ITEM_SQL} WHERE i.project_id = ANY($1) AND i.register = 'safety' AND i.status <> 'closed' AND (i.severity = 'high' OR i.due_on < $2) ORDER BY i.severity = 'high' DESC, i.due_on NULLS LAST`, [ids, t]),
      q(`${ITEM_SQL} WHERE i.project_id = ANY($1) AND i.register = 'quality' AND i.status <> 'closed' AND (i.status = 'failed' OR i.type IN ('ncr', 'inspection', 'hold_point')) ORDER BY i.status = 'failed' DESC, i.due_on NULLS LAST`, [ids]),
      q(`${ACTION_SQL} WHERE a.status = 'open' AND a.due_on < $2 AND (a.project_id = ANY($1) OR (a.project_id IS NULL AND $3)) ORDER BY a.due_on`, [ids, t, seesAll(req.user)]),
      q(`${ACTION_SQL} WHERE a.status = 'open' AND a.needs_director AND (a.project_id = ANY($1) OR (a.project_id IS NULL AND $2)) ORDER BY a.due_on`, [ids, seesAll(req.user)]),
      q(`SELECT e.*, p.name AS project_name, p.ref AS project_ref FROM escalations e JOIN projects p ON p.id = e.project_id WHERE e.closed_at IS NULL AND e.project_id = ANY($1) ORDER BY e.raised_at`, [ids]),
    ]);
    Object.assign(out, { safety_items: lists[0].rows, quality_items: lists[1].rows, overdue_actions: lists[2].rows, director_actions: lists[3].rows, escalations: lists[4].rows, today: t });
  }
  res.json(out);
});

// ---------- RAG rules ----------
r.get('/rules', any, async (req, res) => res.json({ rules: await rag.getRules(), defaults: rag.DEFAULTS }));
r.put('/rules', admin, async (req, res) => {
  const before = await rag.getRules();
  const rules = await rag.setRules((req.body || {}).rules || {});
  const changed = {};
  for (const a of rag.AREAS) for (const k of Object.keys(rules[a])) if (before[a][k] !== rules[a][k]) changed[`${a}.${k}`] = { from: before[a][k], to: rules[a][k] };
  await log(req, 'updated', 'RAG rules', null, null, 'RAG rules changed', Object.keys(changed).length ? changed : null);
  // The stored indicators on each project's latest update follow the new rules.
  for (const p of (await q("SELECT id FROM projects WHERE status = 'live'")).rows) await resnap(p.id);
  res.json({ rules });
});

// ---------- audit trail ----------
r.get('/audit', admin, async (req, res) => {
  const rows = (await q(`SELECT a.id, a.at, a.user_name, a.action, a.entity, a.summary, a.detail, a.project_id, p.name AS project_name, p.ref AS project_ref
    FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id ORDER BY a.at DESC LIMIT 500`)).rows;
  res.json({ rows });
});

// ---------- users ----------
r.get('/users', admin, async (req, res) => {
  res.json({ rows: (await q(`SELECT id, name, email, role, job_title, active, created_at FROM users WHERE $1 OR role <> 'owner' ORDER BY role = 'admin' DESC, name`, [req.user.role === 'owner'])).rows });
});
const rolesFor = u => (u.role === 'owner' ? ['owner', 'admin', 'manager', 'viewer'] : ['admin', 'manager', 'viewer']);
r.post('/users', admin, async (req, res) => {
  const b = req.body || {};
  if (!clean(b.name) || !clean(b.email) || !b.password || b.password.length < 8) throw fail(400, 'Enter a name, an email and a password of at least 8 characters.');
  const role = rolesFor(req.user).includes(b.role) ? b.role : 'manager';
  try {
    const row = (await q('INSERT INTO users (name, email, password_hash, role, job_title) VALUES ($1, LOWER($2), $3, $4, $5) RETURNING id, name, email, role, job_title, active',
      [clean(b.name, 120), clean(b.email, 160), await hash(b.password), role, clean(b.job_title, 120)])).rows[0];
    await log(req, 'created', 'user', row.id, null, `Login added for ${row.name} (${role})`);
    res.json({ row });
  } catch (e) {
    if (e.code === '23505') throw fail(400, 'There is already an account with that email.');
    throw e;
  }
});
r.put('/users/:id', admin, async (req, res) => {
  const b = req.body || {};
  const target = (await q('SELECT id, name, role, active, job_title FROM users WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
  if (!target) throw fail(404, 'Not found.');
  if (target.role === 'owner' && req.user.role !== 'owner') throw fail(403, 'Only the portal owner can change this account.');
  const role = rolesFor(req.user).includes(b.role) ? b.role : null;
  if (target.id === req.user.id && (b.active === false || (role && role !== req.user.role))) throw fail(400, 'You cannot remove your own access.');
  if (b.password && b.password.length < 8) throw fail(400, 'Passwords need at least 8 characters.');
  const row = (await q('UPDATE users SET role = COALESCE($1, role), active = COALESCE($2, active), job_title = $3, name = COALESCE($4, name) WHERE id = $5 RETURNING id, name, role, active, job_title',
    [role, typeof b.active === 'boolean' ? b.active : null, b.job_title === undefined ? target.job_title : clean(b.job_title, 120), clean(b.name, 120), target.id])).rows[0];
  if (b.password) await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await hash(b.password), target.id]);
  await log(req, 'updated', 'user', target.id, null, `Login changed for ${row.name}${b.password ? ' (password reset)' : ''}`, diff(target, row, ['name', 'role', 'active', 'job_title']));
  res.json({ ok: true });
});

// Errors raised with fail() carry their own status and wording.
r.use((err, req, res, next) => { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); });

module.exports = r;
