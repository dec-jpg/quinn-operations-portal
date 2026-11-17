// Email for escalations, sent through Resend when RESEND_API_KEY and MAIL_FROM are set on Railway.
// Without them the portal still records and shows every escalation; it just does not email.
const { q } = require('./db');
const client = require('./client');

const configured = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function escalation(e, project, portalUrl) {
  if (!configured()) return { sent: false };
  const to = (await q("SELECT email FROM users WHERE active AND role = 'admin'")).rows.map(r => r.email);
  if (!to.length) return { sent: false };
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#17150f">
    <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#c0392b;font-weight:bold">Escalation: ${esc(e.kind)}</p>
    <h2 style="margin:0 0 8px">${esc(e.title)}</h2>
    <p><b>${esc(project.ref ? project.ref + ' ' : '')}${esc(project.name)}</b><br>Raised by ${esc(e.raised_by)}</p>
    ${e.detail ? `<p style="white-space:pre-wrap">${esc(e.detail)}</p>` : ''}
    ${portalUrl ? `<p><a href="${esc(portalUrl)}/admin#/escalations">Open in ${esc(client.portal)}</a></p>` : ''}</div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject: `Escalation: ${project.name}: ${e.title}`, html }) });
    return { sent: r.ok };
  } catch (err) { console.error('Escalation email failed:', err.message); return { sent: false }; }
}

module.exports = { configured, escalation };
