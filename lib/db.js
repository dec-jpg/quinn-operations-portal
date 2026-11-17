// Database connection and schema.
// The schema is applied on every boot (all statements are idempotent), so a
// Railway deploy never runs code against a database missing tables or columns.
const { Pool, types } = require('pg');

types.setTypeParser(1082, v => v);               // DATE stays 'YYYY-MM-DD'
types.setTypeParser(20, v => parseInt(v, 10));   // BIGINT and COUNT(*) as numbers
types.setTypeParser(1700, v => parseFloat(v));   // NUMERIC as numbers

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add a PostgreSQL service on Railway and reference its DATABASE_URL.');
  process.exit(1);
}
const needsSsl = /sslmode=require/.test(connectionString) || /proxy\.rlwy\.net/.test(connectionString);
const pool = new Pool({ connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : false, max: 10 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'manager',
  job_title TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  ref TEXT,
  name TEXT NOT NULL,
  client TEXT,
  location TEXT,
  sector TEXT,
  cm_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  contract_value BIGINT,
  start_on DATE,
  planned_completion DATE,
  status TEXT NOT NULL DEFAULT 'live',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS milestones (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  planned_on DATE,
  forecast_on DATE,
  actual_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS milestones_project_idx ON milestones (project_id);

-- One weekly update per project per week (weeks end on a Friday). Every week is kept.
-- "rag" is the five indicators as they stood when the update was last saved, so trends can be shown.
CREATE TABLE IF NOT EXISTS weekly_updates (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  week_ending DATE NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  rag JSONB NOT NULL DEFAULT '{}',
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_name TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, week_ending)
);

-- Safety and quality registers in one table.
CREATE TABLE IF NOT EXISTS register_items (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  register TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  severity TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'open',
  score NUMERIC,
  raised_on DATE NOT NULL,
  due_on DATE,
  closed_on DATE,
  owner TEXT,
  close_note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS register_project_idx ON register_items (project_id, register);

CREATE TABLE IF NOT EXISTS actions (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  area TEXT NOT NULL DEFAULT 'management',
  title TEXT NOT NULL,
  detail TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_name TEXT,
  due_on DATE,
  status TEXT NOT NULL DEFAULT 'open',
  closed_on DATE,
  close_note TEXT,
  needs_director BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS actions_project_idx ON actions (project_id);

-- Matters that cannot wait for the weekly report.
CREATE TABLE IF NOT EXISTS escalations (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  item_id INTEGER REFERENCES register_items(id) ON DELETE SET NULL,
  raised_by TEXT,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  response TEXT,
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS escalations_project_idx ON escalations (project_id);

-- Audit trail: who changed what, and when. Rows are only ever added.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  project_id INTEGER,
  summary TEXT,
  detail JSONB
);
CREATE INDEX IF NOT EXISTS audit_project_idx ON audit_log (project_id, at DESC);
`;

const q = (text, params) => pool.query(text, params);

async function migrate() {
  await pool.query(SCHEMA);
  // The portal owner's master account, from MASTER_EMAIL and MASTER_PASSWORD on Railway: created on first boot,
  // kept in step with the variables after that, always an owner. Quinn's own users are added from inside the portal.
  if (process.env.MASTER_EMAIL && process.env.MASTER_PASSWORD) {
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash(process.env.MASTER_PASSWORD, 10);
    await q(`INSERT INTO users (name, email, password_hash, role, job_title) VALUES ($3, LOWER($1), $2, 'owner', 'Portal support')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'owner'`, [process.env.MASTER_EMAIL, hashed, process.env.MASTER_NAME || 'Tresor']);
  }
}

module.exports = { pool, q, migrate };
