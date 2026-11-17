// Tresor feed: a read-only summary of this portal for the Tresor dashboard.
// Locked with TRESOR_KEY (set on Railway); nothing here is reachable without it.
const express = require('express');
const crypto = require('crypto');
const { q } = require('../lib/db');
const client = require('../lib/client');
const rag = require('../lib/rag');
const { today, weekEnding } = require('../lib/util');

const r = express.Router();
r.use((req, res, next) => {
  const key = process.env.TRESOR_KEY, given = req.get('x-tresor-key') || '';
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return res.status(401).json({ error: 'Not authorised.' });
  next();
});

r.get('/summary', async (req, res) => {
  const projects = (await q("SELECT * FROM projects WHERE status = 'live' ORDER BY name")).rows;
  const live = await rag.forProjects(projects);
  const week = weekEnding();
  const one = (await q(`SELECT (SELECT COUNT(*) FROM actions WHERE status = 'open' AND due_on < $1) AS overdue_actions,
    (SELECT COUNT(*) FROM escalations WHERE closed_at IS NULL) AS open_escalations, (SELECT MAX(updated_at) FROM weekly_updates) AS last_update`, [today()])).rows[0];
  const count = s => projects.filter(p => Object.values(live[p.id].rag).some(a => a.s === s)).length;
  res.json({ kind: 'operations', portal: client.portal, company: client.company, week,
    counts: { live_projects: projects.length, red: count('red'), amber: count('amber'), updates_in: projects.filter(p => live[p.id].latest && live[p.id].latest.week_ending === week).length, ...one },
    projects: projects.map(p => ({ ref: p.ref, name: p.name, rag: Object.fromEntries(Object.entries(live[p.id].rag).map(([k, v]) => [k, v.s])) })) });
});

module.exports = r;
