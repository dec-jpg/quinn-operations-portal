# Quinn Operations

Operations portal for Quinn's Renewables & Major Projects division, on the Tresor portal base.

One dashboard of every live project with five automated indicators (Programme, Commercial, Safety, Quality, Management actions),
a project register, a short weekly update per project, safety and quality registers, a central action tracker,
immediate escalations, a weekly executive summary, RAG rules a director can change, and an audit trail.

## Logins

- Director: sees and changes everything, adds users, sets the RAG rules, responds to escalations.
- Contracts Manager: sees and updates only the projects given to them.
- View only: sees every project, changes nothing.
- Portal support: the master login from `MASTER_EMAIL` / `MASTER_PASSWORD`.

## Hosting

Railway (Node.js, PostgreSQL). The schema is applied on every boot. No demo data: the portal starts empty.

Variables: `DATABASE_URL`, `MASTER_EMAIL`, `MASTER_PASSWORD`, `TRESOR_KEY`, `NODE_ENV=production`.
Optional: `PUBLIC_URL`, and `RESEND_API_KEY` + `MAIL_FROM` to email escalations to director logins.

Branding is in `client/config.json` (name, colour, the director's name used in the wording, sectors); drop a `client/logo.png` or `logo.svg` in to show a logo.
