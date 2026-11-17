// Operations portal front end.
(() => {
  const root = document.getElementById('root');
  const dlg = document.getElementById('dlg');
  let me = null;
  let brand = { name: '', portal: 'Operations', division: '', director: 'the director', sectors: [], logo: false };
  const cache = { projects: null, people: null };

  // ---------- helpers ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tz = { timeZone: 'Europe/London' };
  const fDate = d => {
    if (!d) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { const [y, m, dd] = d.split('-'); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
    return new Date(d).toLocaleDateString('en-GB', { ...tz, day: '2-digit', month: 'short', year: 'numeric' });
  };
  const fTime = d => (d ? new Date(d).toLocaleTimeString('en-GB', { ...tz, hour: '2-digit', minute: '2-digit' }) : '');
  const fDT = d => (d ? `${fDate(d)} ${fTime(d)}` : '');
  const money = n => (n == null || n === '' ? '' : '£' + Math.round(n).toLocaleString('en-GB'));
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const canEdit = () => me && me.role !== 'viewer';
  const isAdmin = () => me && (me.role === 'admin' || me.role === 'owner');
  const isOwner = () => me && me.role === 'owner';
  const todayIso = () => new Intl.DateTimeFormat('en-CA', tz).format(new Date());
  const pname = x => `${x.project_ref ? esc(x.project_ref) + ' · ' : ''}${esc(x.project_name || '')}`;

  async function api(path, opts = {}) {
    const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
    if (opts.body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    const res = await fetch(path.startsWith('/api') ? path : '/api/admin' + path, init);
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    if (res.status === 401 && !path.startsWith('/api/auth')) { me = null; showLogin(); throw new Error('Log in to continue.'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }
  async function projects(force) { if (!cache.projects || force) cache.projects = (await api('/projects')).rows; return cache.projects; }
  async function people(force) { if (!cache.people || force) cache.people = (await api('/people')).rows; return cache.people; }
  const bust = () => { cache.projects = cache.people = null; };

  const main = () => document.getElementById('main');
  const setMain = html => { main().innerHTML = html; };
  function flash(msg, kind = 'ok') {
    const n = document.createElement('div'); n.className = `note ${kind} no-print`; n.textContent = msg;
    main().prepend(n); setTimeout(() => n.remove(), kind === 'err' ? 7000 : 3500);
  }
  let pendingFlash = null;
  function dlgErr(msg) {
    let n = dlg.querySelector('.dlg-body .note.err');
    if (!n) { n = document.createElement('div'); n.className = 'note err'; dlg.querySelector('.dlg-body').prepend(n); }
    n.textContent = msg; n.scrollIntoView({ block: 'nearest' });
  }
  function openDlg(title, body, foot = '') {
    dlg.innerHTML = `<div class="dlg-head"><h2>${esc(title)}</h2><button class="btn quiet" data-close aria-label="Close">Close</button></div>
      <div class="dlg-body">${body}</div>${foot ? `<div class="dlg-foot">${foot}</div>` : ''}`;
    dlg.querySelectorAll('[data-close]').forEach(b => (b.onclick = () => dlg.close()));
    if (!dlg.open) dlg.showModal();
    return dlg;
  }
  const $d = sel => dlg.querySelector(sel);
  const val = sel => { const el = $d(sel); return el ? el.value : null; };
  const v = id => document.getElementById(id).value;
  const field = (label, html, hint) => `<div class="field"><label>${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</label>${html}</div>`;
  const input = (id, value, type = 'text', extra = '') => `<input id="${id}" type="${type}" value="${esc(value ?? '')}" ${extra}>`;
  const select = (id, options, sel, extra = '') => `<select id="${id}" ${extra}>${options.map(([k, l]) => `<option value="${esc(k)}" ${String(sel ?? '') === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  // ---------- RAG ----------
  const AREAS = [['programme', 'Programme'], ['commercial', 'Commercial'], ['safety', 'Safety'], ['quality', 'Quality'], ['management', 'Management actions']];
  const RAG_WORD = { green: 'Green', amber: 'Amber', red: 'Red', none: 'No data' };
  const ragPill = a => { const s = (a && a.s) || 'none'; return `<span class="rag ${s}" title="${esc(((a && a.why) || []).join('\n') || (s === 'green' ? 'Nothing flagged' : s === 'none' ? 'Nothing recorded yet' : ''))}">${RAG_WORD[s]}</span>`; };
  const ragDot = (a, label) => { const s = (a && a.s) || 'none'; return `<span class="dot ${s}" role="img" aria-label="${esc(label)}: ${RAG_WORD[s]}" title="${esc(label)}: ${RAG_WORD[s]}${a && a.why && a.why.length ? '\n' + esc(a.why.join('\n')) : ''}"></span>`; };
  const worst = rag => (AREAS.some(([k]) => rag[k].s === 'red') ? 'red' : AREAS.some(([k]) => rag[k].s === 'amber') ? 'amber' : AREAS.every(([k]) => rag[k].s === 'green') ? 'green' : 'none');

  // ---------- login ----------
  async function boot() {
    try { brand = await (await fetch('/api/brand')).json(); } catch { /* defaults */ }
    document.title = brand.portal;
    const s = await api('/api/auth/state');
    if (s.user) { me = s.user; return shell(); }
    showLogin(s);
  }
  const loginMark = () => (brand.logo ? `<img src="/logo" alt="${esc(brand.name)}">` : `<div style="font-size:1.5rem;font-weight:800;letter-spacing:-.03em;margin-bottom:.2rem;color:var(--oak)">${esc(brand.name)}</div>`) + `<div class="sub" style="margin-top:0">${esc(brand.division || brand.portal)}</div>`;

  async function showLogin(state) {
    const s = state || await api('/api/auth/state');
    if (s.needsSetup) {
      root.innerHTML = `<div class="login-wrap"><div class="login-card">${loginMark()}<h1>Set up the portal</h1>
        ${s.setupEnabled ? `<p class="muted">Create the first account. Everyone else is added from inside the portal.</p><div id="msg"></div>
          ${field('Setup key', input('k', '', 'password'))}${field('Your name', input('n', '', 'text', 'autocomplete="name"'))}
          ${field('Email', input('e', '', 'email', 'autocomplete="email"'))}${field('Password', input('p', '', 'password', 'autocomplete="new-password"'), 'at least 8 characters')}
          <button class="btn big" id="go">Create account</button>`
          : '<div class="note warn">This portal has no logins yet. Portal support will set the first one up.</div>'}</div></div>`;
      const go = document.getElementById('go');
      if (go) go.onclick = async () => {
        try { const r = await api('/api/auth/setup', { body: { setup_key: v('k'), name: v('n'), email: v('e'), password: v('p') } }); me = r.user; shell(); }
        catch (e) { document.getElementById('msg').innerHTML = `<div class="note err">${esc(e.message)}</div>`; }
      };
      return;
    }
    root.innerHTML = `<div class="login-wrap"><div class="login-card">${loginMark()}<h1>Log in</h1><div id="msg"></div>
      ${field('Email', input('e', '', 'email', 'autocomplete="username"'))}${field('Password', input('p', '', 'password', 'autocomplete="current-password"'))}
      <button class="btn big" id="go">Log in</button></div></div>`;
    const go = async () => {
      try { const r = await api('/api/auth/login', { body: { email: v('e'), password: v('p') } }); me = r.user; bust(); shell(); }
      catch (e) { document.getElementById('msg').innerHTML = `<div class="note err">${esc(e.message)}</div>`; }
    };
    document.getElementById('go').onclick = go;
    document.getElementById('p').onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  // ---------- shell & routing ----------
  const ICONS = {
    '': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    report: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>',
    projects: '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/>',
    weekly: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 15l2.5 2.5L16 12"/>',
    safety: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    quality: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    actions: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    escalations: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>',
    rules: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
    audit: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  const NAV = [
    ['Overview'], ['', 'Dashboard'], ['report', 'Weekly summary'],
    ['Projects'], ['projects', 'Project register'], ['weekly', 'Weekly updates'],
    ['Registers'], ['safety', 'Safety register'], ['quality', 'Quality register'], ['actions', 'Action tracker'], ['escalations', 'Escalations'],
    ['Admin', 'admin'], ['users', 'Users', 'admin'], ['rules', 'RAG rules', 'admin'], ['audit', 'Audit trail', 'admin'],
  ];
  const CRUMB = { '': 'Every live project at a glance', report: 'The week in one page', projects: 'Every project and its Contracts Manager', weekly: 'One short update per project, every week',
    update: 'Weekly update', safety: 'Audits, findings, incidents, near misses, temporary works and critical activities', quality: 'Inspections, hold points, non-conformance reports, defects, testing and handover documents',
    actions: 'Who is doing what, by when', escalations: 'Matters that cannot wait for the weekly report', users: 'Who can log in', rules: 'The thresholds behind every Green, Amber and Red', audit: 'Who changed what, and when' };

  function shell() {
    const allowed = r => !r || isAdmin();
    const items = NAV.filter(n => (n.length === 1 || n[1] === 'admin' ? allowed(n[1]) : allowed(n[2]))).map(n => (n.length === 1 || (n[1] === 'admin' && n.length === 2)
      ? `<div class="nav-label">${n[0]}</div>`
      : `<a href="#/${n[0]}" data-nav="${n[0]}"><svg class="ic" viewBox="0 0 24 24">${ICONS[n[0]]}</svg>${esc(n[1])}<span class="count hidden" data-count="${n[0]}"></span></a>`)).join('');
    const role = { owner: 'Portal support', admin: 'Director', manager: 'Contracts Manager', viewer: 'View only' }[me.role];
    root.innerHTML = `<div class="ad-shell"><aside class="ad-nav" id="rail"><div class="rail-brand">${brand.logo ? `<div class="logo"><img src="/logo" alt="${esc(brand.name)}"></div>` : ''}
        <div class="t" ${brand.logo ? '' : 'style="font-size:17px;font-weight:800"'}>${esc(brand.portal)}</div><div class="s">${esc(brand.division)}</div></div>
      <nav aria-label="Main">${items}</nav>
      <div class="rail-foot"><div class="live"><span class="dot" style="width:6px;height:6px;background:#7fd1a0"></span>Live</div><div style="margin-top:6px">Powered by Tresor</div></div></aside>
      <div class="scrim" id="scrim"></div>
      <div class="ad-body"><div class="topbar"><div style="display:flex;align-items:center;gap:14px"><button class="burger" id="burger" aria-label="Menu"><svg viewBox="0 0 24 24"><path d="M3 12h18M3 6h18M3 18h18"/></svg></button>
        <div><h1 id="vt">Dashboard</h1><div class="crumb" id="vc"></div></div></div>
        <div class="userchip"><span><b>${esc(me.name)}</b> · ${role}</span><button id="pw">Password</button><button id="lo">Sign out</button></div></div>
      <main class="ad-main" id="main"></main></div></div>`;
    document.getElementById('lo').onclick = async () => { await api('/api/auth/logout', { body: {} }); me = null; bust(); showLogin(); };
    document.getElementById('pw').onclick = changePassword;
    const rail = document.getElementById('rail'), scrim = document.getElementById('scrim');
    const menu = on => { rail.classList.toggle('open', on); scrim.classList.toggle('show', on); };
    document.getElementById('burger').onclick = () => menu(true);
    scrim.onclick = () => menu(false);
    rail.addEventListener('click', e => { if (e.target.closest('a')) menu(false); });
    window.onhashchange = route;
    route();
  }

  const VIEWS = () => ({ '': dashboard, report, projects: projectsView, weekly, update: updateForm, safety: p => register('safety', p), quality: p => register('quality', p), actions: actionsView, escalations, users, rules, audit });
  function route() {
    const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
    const params = new URLSearchParams(qs || '');
    const [view, id] = path.split('/');
    const navKey = view === 'update' ? 'weekly' : (view || '');
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === navKey));
    const nav = NAV.find(n => n.length > 1 && n[0] === navKey && n[1] !== 'admin');
    document.getElementById('vt').textContent = nav ? nav[1] : 'Dashboard';
    document.getElementById('vc').textContent = `${brand.name} ${brand.division} · ${CRUMB[view || ''] || ''}`;
    window.scrollTo(0, 0);
    if (dlg.open) dlg.close();
    setMain('<p class="muted">Loading</p>');
    Promise.resolve().then(() => (VIEWS()[view] || dashboard)(params, id)).then(() => { if (pendingFlash) { flash(...pendingFlash); pendingFlash = null; } })
      .catch(e => { if (me) setMain(`<div class="note err">${esc(e.message)}</div>`); });
    updateCounts();
  }
  const reload = () => route();
  const go = hash => { if (location.hash === hash) route(); else location.hash = hash; };

  async function updateCounts() {
    try {
      const d = await api('/overview');
      const set = (k, n) => { const el = document.querySelector(`[data-count=${k}]`); if (el) { el.textContent = n; el.classList.toggle('hidden', !n); } };
      set('escalations', d.escalations.filter(e => !e.acknowledged_at).length);
      set('actions', d.overdue_actions);
      set('weekly', d.projects.filter(p => !p.update_in).length);
    } catch { /* ignore */ }
  }

  function changePassword() {
    openDlg('Change password', field('Current password', '<input id="c" type="password" autocomplete="current-password">') +
      field('New password', '<input id="n" type="password" autocomplete="new-password">', 'at least 8 characters'), '<button class="btn" id="save">Change password</button>');
    $d('#save').onclick = async () => {
      try { await api('/api/auth/password', { body: { current: val('#c'), next: val('#n') } }); dlg.close(); flash('Password changed.'); }
      catch (e) { dlgErr(e.message); }
    };
  }

  // ---------- dashboard ----------
  async function dashboard() {
    const d = await api('/overview');
    const ps = d.projects;
    if (!ps.length) {
      return setMain(`<div class="panel"><div class="empty"><b>No live projects yet</b>${isAdmin() ? 'Add the Contracts Managers under Users, then add each project to the register.' : 'Projects appear here once they are added to the register and given to you.'}
        ${isAdmin() ? '<div style="margin-top:1rem;display:flex;gap:.6rem;justify-content:center"><a class="btn ghost" href="#/users">Add users</a><a class="btn" href="#/projects?new=1">Add a project</a></div>' : ''}</div></div>`);
    }
    const reds = ps.filter(p => worst(p.rag) === 'red').length, due = ps.filter(p => !p.update_in).length;
    const esc_ = d.escalations;
    setMain(`${esc_.map(e => `<div class="flag red" style="margin-bottom:10px"><div><span class="k" style="color:var(--brick)">${esc(e.kind)}${e.acknowledged_at ? ' · acknowledged' : ' · waiting for a response'}</span><br><b>${pname(e)}</b>: ${esc(e.title)}
        <span class="sub">· raised by ${esc(e.raised_by)}, ${fDT(e.raised_at)}</span></div><a class="btn small ghost" href="#/escalations">Open</a></div>`).join('')}
      <div class="stats">
        <a class="stat accent" href="#/projects"><div class="n">${ps.length}</div><div class="l">Live projects</div></a>
        <a class="stat ${reds ? 'bad' : ''}" href="#/"><div class="n">${reds}</div><div class="l">With a red indicator</div></a>
        <a class="stat" href="#/weekly"><div class="n">${due}</div><div class="l">Updates due this week</div></a>
        <a class="stat ${d.overdue_actions ? 'bad' : ''}" href="#/actions?show=overdue"><div class="n">${d.overdue_actions}</div><div class="l">Overdue actions</div></a>
      </div>
      <div class="tablewrap"><table><thead><tr><th>Project</th><th>Contracts Manager</th>${AREAS.map(a => `<th>${a[1]}</th>`).join('')}<th>Last update</th></tr></thead><tbody>
        ${ps.map(p => `<tr class="click" data-p="${p.id}"><td><b>${esc(p.name)}</b><div class="sub">${[p.ref, p.client].filter(Boolean).map(esc).join(' · ')}</div></td><td>${esc(p.cm_name || 'Not set')}</td>
          ${AREAS.map(a => `<td class="rc">${ragPill(p.rag[a[0]])}</td>`).join('')}
          <td>${p.last_week ? `w/e ${fDate(p.last_week)}` : '<span class="muted">None yet</span>'}${p.update_in ? '' : '<div class="sub">This week\'s is due</div>'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted">Week ending ${fDate(d.week)}. Indicators are worked out from the latest weekly update, the registers and the action tracker. Hover over one to see why${isAdmin() ? ', or change the thresholds under <a href="#/rules">RAG rules</a>' : ''}.</p>`);
    main().querySelectorAll('[data-p]').forEach(tr => (tr.onclick = () => go(`#/projects/${tr.dataset.p}`)));
  }

  // ---------- project register ----------
  async function projectsView(params, id) {
    if (id) return projectPage(id, params);
    const rows = await projects(true);
    setMain(`<div class="ad-head"><div><p class="muted">${rows.length ? `${rows.filter(p => p.status === 'live').length} live, ${rows.length} in total.` : 'No projects on the register yet.'}</p></div>${isAdmin() ? '<button class="btn" id="add">Add project</button>' : ''}</div>
      ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Ref</th><th>Project</th><th>Client</th><th>Sector</th><th>Contracts Manager</th><th class="num">Contract value</th><th>Planned completion</th><th>Status</th></tr></thead><tbody>
        ${rows.map(p => `<tr class="click" data-p="${p.id}"><td>${esc(p.ref || '')}</td><td><b>${esc(p.name)}</b><div class="sub">${esc(p.location || '')}</div></td><td>${esc(p.client || '')}</td><td>${esc(p.sector || '')}</td><td>${esc(p.cm_name || 'Not set')}</td>
          <td class="num">${money(p.contract_value)}</td><td>${fDate(p.planned_completion)}</td><td><span class="pill ${p.status === 'live' ? 'yes' : 'grey'}">${esc(p.status)}</span></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="panel"><div class="empty"><b>Nothing here yet</b>Each project is added once, with its Contracts Manager, contract value and planned completion date.</div></div>'}`);
    main().querySelectorAll('[data-p]').forEach(tr => (tr.onclick = () => go(`#/projects/${tr.dataset.p}`)));
    const add = document.getElementById('add');
    if (add) { add.onclick = () => projectDialog(null); if (params.get('new')) projectDialog(null); }
  }

  async function projectDialog(p) {
    const ppl = (await people(true)).filter(u => u.role === 'manager' || u.role === 'admin');
    if (!ppl.length) return openDlg('Add project', '<div class="note warn">Add the Contracts Managers under Users first, so the project can be given to one of them.</div>', '<a class="btn" href="#/users" data-close>Go to Users</a>');
    p = p || {};
    openDlg(p.id ? 'Edit project' : 'Add project', `<div class="row">${field('Project name', input('p_name', p.name))}${field('Reference', input('p_ref', p.ref), 'optional')}</div>
      <div class="row">${field('Client', input('p_client', p.client))}${field('Location', input('p_location', p.location))}</div>
      <div class="row">${field('Sector', select('p_sector', [['', 'Choose'], ...brand.sectors.map(s => [s, s])], p.sector))}${field('Contracts Manager', select('p_cm', [['', 'Choose'], ...ppl.map(u => [u.id, u.name])], p.cm_id))}</div>
      <div class="row">${field('Contract value (£)', input('p_value', p.contract_value, 'number', 'min="0" step="1000"'))}${field('Status', select('p_status', [['live', 'Live'], ['on hold', 'On hold'], ['complete', 'Complete']], p.status || 'live'))}</div>
      <div class="row">${field('Start date', input('p_start', p.start_on, 'date'))}${field('Planned completion', input('p_end', p.planned_completion, 'date'))}</div>
      ${field('Notes', `<textarea id="p_notes">${esc(p.notes || '')}</textarea>`, 'optional')}`, `<button class="btn" id="save">${p.id ? 'Save changes' : 'Add project'}</button>`);
    $d('#save').onclick = async () => {
      const body = { name: val('#p_name'), ref: val('#p_ref'), client: val('#p_client'), location: val('#p_location'), sector: val('#p_sector'), cm_id: val('#p_cm'), contract_value: val('#p_value'), status: val('#p_status'), start_on: val('#p_start'), planned_completion: val('#p_end'), notes: val('#p_notes') };
      try { const r = await api(p.id ? `/projects/${p.id}` : '/projects', { method: p.id ? 'PUT' : 'POST', body }); bust(); dlg.close(); pendingFlash = [p.id ? 'Project saved.' : 'Project added.']; go(`#/projects/${r.row.id}`); }
      catch (e) { dlgErr(e.message); }
    };
  }

  // ---------- one project ----------
  const TYPE = { audit: 'Site audit', finding: 'Audit finding', incident: 'Incident', near_miss: 'Near miss', temporary_works: 'Temporary works', critical_activity: 'Critical activity',
    inspection: 'Inspection', hold_point: 'Hold point', ncr: 'Non-conformance report', defect: 'Defect or rework', test: 'Test or certificate', handover_doc: 'Handover document' };
  const TYPES = { safety: ['finding', 'incident', 'near_miss', 'temporary_works', 'critical_activity', 'audit'], quality: ['inspection', 'hold_point', 'ncr', 'defect', 'test', 'handover_doc'] };
  const CAN_FAIL = ['inspection', 'hold_point', 'test'];
  const margin = (p, d) => { const value = (p.contract_value || 0) + (d.approved_variations || 0); return value > 0 && isNum(d.forecast_cost) ? Math.round(((value - d.forecast_cost) / value) * 1000) / 10 : null; };
  const said = (label, text) => (text ? `<div class="said"><span class="k">${label}</span><p>${esc(text)}</p></div>` : '');

  async function projectPage(id, params) {
    const d = await api(`/projects/${id}`);
    const p = d.project, tab = params.get('tab') || 'overview', u = d.updates[0] || null, ud = u ? u.data : {};
    const edit = d.can_edit;
    document.getElementById('vt').textContent = p.name;
    document.getElementById('vc').textContent = [p.ref, p.client, p.location, p.sector].filter(Boolean).join(' · ');
    const tabs = [['overview', 'Overview'], ['updates', `Weekly updates (${d.updates.length})`], ['safety', 'Safety'], ['quality', 'Quality'], ['actions', `Actions (${d.actions.filter(a => a.status === 'open').length})`], ['history', 'History']];
    const openEsc = d.escalations.filter(e => !e.closed_at);
    let body = '';
    if (tab === 'overview') {
      const m = margin(p, ud);
      body = `<div class="panel"><div class="facts">
          <div><span class="k">Contracts Manager</span><div class="v">${esc(p.cm_name || 'Not set')}</div></div>
          <div><span class="k">Contract value</span><div class="v">${money(p.contract_value) || 'Not set'}</div>${ud.approved_variations ? `<div class="sub">plus ${money(ud.approved_variations)} approved variations</div>` : ''}</div>
          <div><span class="k">Forecast margin</span><div class="v">${m == null ? 'No forecast yet' : m + '%'}</div></div>
          <div><span class="k">Planned completion</span><div class="v">${fDate(p.planned_completion) || 'Not set'}</div>${ud.forecast_completion ? `<div class="sub">forecast ${fDate(ud.forecast_completion)}</div>` : ''}</div>
          <div><span class="k">Progress</span>${u ? `<div class="sub" style="margin-top:4px">Planned ${ud.planned_pct}%</div><div class="bar plan"><i style="width:${ud.planned_pct}%"></i></div><div class="sub" style="margin-top:6px">Actual ${ud.actual_pct}%</div><div class="bar"><i style="width:${ud.actual_pct}%"></i></div>` : '<div class="v">No update yet</div>'}</div>
        </div></div>
        ${u ? `<h2>Latest update: week ending ${fDate(u.week_ending)}</h2><div class="panel">${said('Summary', ud.summary)}${said('Delays', ud.delay)}${said('Recovery actions', ud.recovery)}${said('Commercial risks', ud.commercial_risk)}
          ${said('Temporary works and critical activities', ud.critical_activities)}${said('Safety notes', ud.safety_note)}${said('Quality risks to programme', ud.quality_risk)}${said(`Issues needing ${esc(brand.director)}`, ud.issues)}${said(`Decision required from ${esc(brand.director)}`, ud.decision)}
          <p class="small muted" style="margin:.6rem 0 0">From ${esc(u.submitted_name || '')}, ${fDT(u.updated_at)}</p></div>` : ''}
        <h2>Key milestones</h2>
        ${d.milestones.length ? `<div class="tablewrap"><table><thead><tr><th>Milestone</th><th>Planned</th><th>Forecast</th><th>Achieved</th><th></th></tr></thead><tbody>
          ${d.milestones.map(x => { const late = !x.actual_on && (x.forecast_on || x.planned_on) && (x.forecast_on || x.planned_on) < todayIso(); return `<tr><td><b>${esc(x.name)}</b></td><td>${fDate(x.planned_on)}</td><td>${fDate(x.forecast_on)}</td>
            <td>${x.actual_on ? `<span class="pill yes">${fDate(x.actual_on)}</span>` : late ? '<span class="pill overdue">Past its date</span>' : ''}</td><td style="text-align:right">${edit ? `<button class="btn small quiet" data-ms="${x.id}">Edit</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No milestones set for this project yet.</p>'}
        ${edit ? '<button class="btn small ghost" id="addms">Add milestone</button>' : ''}`;
    } else if (tab === 'updates') {
      body = d.updates.length ? `<div class="tablewrap"><table><thead><tr><th>Week ending</th>${AREAS.map(a => `<th title="${a[1]}">${a[1].slice(0, 4)}</th>`).join('')}<th class="num">Planned</th><th class="num">Actual</th><th class="num">Margin</th><th class="num">Incidents</th><th class="num">Near misses</th><th>From</th></tr></thead><tbody>
        ${d.updates.map((x, i) => { const m = margin(p, x.data); return `<tr class="click" data-u="${i}"><td><b>${fDate(x.week_ending)}</b></td>${AREAS.map(a => `<td>${ragDot((x.rag || {})[a[0]], a[1])}</td>`).join('')}
          <td class="num">${x.data.planned_pct ?? ''}%</td><td class="num">${x.data.actual_pct ?? ''}%</td><td class="num">${m == null ? '' : m + '%'}</td><td class="num">${x.data.incidents ?? 0}</td><td class="num">${x.data.near_misses ?? 0}</td><td>${esc(x.submitted_name || '')}</td></tr>`; }).join('')}</tbody></table></div>
        <p class="small muted">Every week is kept. Newest first; each row shows the five indicators as they stood that week.</p>` : '<div class="panel"><div class="empty"><b>No weekly updates yet</b>The first one sets the starting point for every indicator.</div></div>';
    } else if (tab === 'safety' || tab === 'quality') {
      const rows = d.items.filter(i => i.register === tab);
      body = `<div class="ad-head"><div><p class="muted">${tab === 'safety' ? 'Audits, findings, incidents, near misses, temporary works and critical activities on this project.' : 'Inspections, hold points, non-conformance reports, defects, tests and handover documents on this project.'}</p></div>${edit ? `<button class="btn" id="additem">Add entry</button>` : ''}</div>${itemsTable(rows, false)}`;
    } else if (tab === 'actions') {
      body = `<div class="ad-head"><div><p class="muted">Actions on this project, with who is responsible and the target date.</p></div>${edit ? '<button class="btn" id="addaction">Add action</button>' : ''}</div>${actionsTable(d.actions, false)}`;
    } else {
      body = auditTable(d.history, false);
    }
    setMain(`<div class="ad-head"><div><p class="muted">${esc(p.cm_name ? `Contracts Manager: ${p.cm_name}` : 'No Contracts Manager set')}${p.status !== 'live' ? ` · <span class="pill grey">${esc(p.status)}</span>` : ''}</p></div>
        <div>${edit ? `<a class="btn" href="#/update/${p.id}">${u && u.week_ending === d.week ? 'Edit this week\'s update' : 'Weekly update'}</a><button class="btn ghost" id="escalate">Escalate now</button>` : ''}${isAdmin() ? '<button class="btn ghost" id="editp">Edit project</button>' : ''}</div></div>
      ${openEsc.map(e => `<div class="flag red" style="margin-bottom:10px"><div><span class="k" style="color:var(--brick)">${esc(e.kind)}${e.acknowledged_at ? ' · acknowledged' : ' · waiting for a response'}</span><br>${esc(e.title)}</div><a class="btn small ghost" href="#/escalations">Open</a></div>`).join('')}
      <div class="ragcards">${AREAS.map(([k, l]) => { const a = d.rag[k]; return `<div class="ragcard ${a.s}"><div class="l">${l}</div>${ragPill(a)}${a.why.length ? `<ul>${a.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : `<p>${a.s === 'none' ? 'Nothing recorded yet' : 'Nothing flagged'}</p>`}</div>`; }).join('')}</div>
      <div class="tabs no-print">${tabs.map(t => `<button data-tab="${t[0]}" class="${t[0] === tab ? 'on' : ''}">${t[1]}</button>`).join('')}</div>${body}`);
    main().querySelectorAll('[data-tab]').forEach(b => (b.onclick = () => go(`#/projects/${p.id}?tab=${b.dataset.tab}`)));
    const on = (sel, fn) => { const el = document.getElementById(sel); if (el) el.onclick = fn; };
    on('editp', () => projectDialog(p));
    on('escalate', () => escalateDialog(p.id));
    on('addms', () => milestoneDialog(p.id, null));
    main().querySelectorAll('[data-ms]').forEach(b => (b.onclick = () => milestoneDialog(p.id, d.milestones.find(x => x.id === Number(b.dataset.ms)))));
    on('additem', () => itemDialog(null, tab, p.id));
    on('addaction', () => actionDialog(null, p.id));
    bindItems(d.items, edit); bindActions(d.actions);
    main().querySelectorAll('[data-u]').forEach(tr => (tr.onclick = () => updateDetail(p, d.updates[Number(tr.dataset.u)], edit)));
  }

  function milestoneDialog(projectId, m) {
    m = m || {};
    openDlg(m.id ? 'Edit milestone' : 'Add milestone', `${field('Milestone', input('m_name', m.name))}
      <div class="row">${field('Planned date', input('m_plan', m.planned_on, 'date'))}${field('Forecast date', input('m_fore', m.forecast_on, 'date'), 'if it has moved')}${field('Achieved on', input('m_act', m.actual_on, 'date'), 'once done')}</div>`,
      `${m.id ? '<button class="btn quiet left" id="del">Remove</button>' : ''}<button class="btn" id="save">Save</button>`);
    $d('#save').onclick = async () => {
      const body = { name: val('#m_name'), planned_on: val('#m_plan'), forecast_on: val('#m_fore'), actual_on: val('#m_act') };
      try { await api(m.id ? `/milestones/${m.id}` : `/projects/${projectId}/milestones`, { method: m.id ? 'PUT' : 'POST', body }); dlg.close(); reload(); } catch (e) { dlgErr(e.message); }
    };
    if (m.id) $d('#del').onclick = async () => { if (!confirm('Remove this milestone?')) return; try { await api(`/milestones/${m.id}`, { method: 'DELETE' }); dlg.close(); reload(); } catch (e) { dlgErr(e.message); } };
  }

  function updateDetail(p, x, edit) {
    const d = x.data, m = margin(p, d);
    const line = (l, val) => (val == null || val === '' ? '' : `<div><dt>${l}</dt><dd>${esc(val)}</dd></div>`);
    openDlg(`Week ending ${fDate(x.week_ending)}`, `<p style="display:flex;gap:.4rem;flex-wrap:wrap">${AREAS.map(a => `<span>${ragPill((x.rag || {})[a[0]])}</span>`).join('')}</p>
      <dl class="info-list">${line('Progress', `Planned ${d.planned_pct}%, actual ${d.actual_pct}%`)}${line('Forecast completion', fDate(d.forecast_completion))}${line('Delays', d.delay)}${line('Recovery actions', d.recovery)}
      ${line('Approved variations', money(d.approved_variations))}${line('Applied / certified / paid to date', [d.applied, d.certified, d.paid].some(isNum) ? [d.applied, d.certified, d.paid].map(n => money(n) || 'not given').join(' / ') : '')}
      ${line('Payment overdue', d.overdue_amount ? `${money(d.overdue_amount)}${isNum(d.overdue_days) ? `, ${d.overdue_days} days` : ''}` : '')}${line('Variations not yet agreed', d.unagreed_value || d.unagreed_n ? `${d.unagreed_n ?? ''} ${money(d.unagreed_value)}`.trim() : '')}
      ${line('Contractual notices open', d.notices_open)}${line('Forecast final cost', money(d.forecast_cost))}${line('Forecast margin', m == null ? '' : m + '%')}${line('Commercial risks', d.commercial_risk)}
      ${line('Site audit', d.audit_on ? `${fDate(d.audit_on)}: ${d.audit_score}%` : '')}${line('Incidents / near misses this week', `${d.incidents ?? 0} / ${d.near_misses ?? 0}`)}${line('Temporary works and critical activities', d.critical_activities)}${line('Safety notes', d.safety_note)}
      ${line('Inspection and Test Plan', isNum(d.itp_planned_pct) ? `Planned ${d.itp_planned_pct}%, actual ${d.itp_actual_pct ?? 0}%` : '')}${line('Inspections outstanding', d.inspections_due)}${line('Tests and certificates outstanding', d.tests_outstanding)}${line('Handover documents outstanding', d.handover_outstanding)}${line('Quality risks to programme', d.quality_risk)}
      ${line('Summary', d.summary)}${line(`Issues needing ${brand.director}`, d.issues)}${line(`Decision required from ${brand.director}`, d.decision)}</dl>
      <p class="small muted">From ${esc(x.submitted_name || '')}, ${fDT(x.updated_at)}</p>`, edit ? `<a class="btn ghost" href="#/update/${p.id}?week=${x.week_ending}" data-close>Correct this update</a>` : '');
  }

  // ---------- weekly updates ----------
  async function weekly() {
    const d = await api('/weekly');
    const mine = d.projects.filter(p => p.can_edit), dueN = d.projects.filter(p => !p.update).length;
    setMain(`<div class="ad-head"><div><p class="muted">Week ending ${fDate(d.week)}. ${d.projects.length ? (dueN ? `${dueN} of ${d.projects.length} still to come in.` : 'Every update is in.') : ''}</p></div></div>
      ${canEdit() ? `<div class="note info">A serious incident, a failed hold point or an urgent contractual matter does not wait for this form: use <b>Escalate now</b> on the project page and ${esc(brand.director)} sees it straight away.</div>` : ''}
      ${d.projects.length ? `<div class="tablewrap"><table><thead><tr><th>Project</th><th>Contracts Manager</th><th>This week</th><th></th></tr></thead><tbody>
        ${d.projects.map(p => `<tr><td><b>${esc(p.name)}</b><div class="sub">${esc(p.ref || '')}</div></td><td>${esc(p.cm_name || 'Not set')}</td>
          <td>${p.update ? `<span class="pill yes">In</span> <span class="sub">${esc(p.update.submitted_name || '')}, ${fDT(p.update.updated_at)}</span>` : '<span class="pill under_review">Due</span>'}</td>
          <td style="text-align:right">${p.can_edit ? `<a class="btn small ${p.update ? 'ghost' : ''}" href="#/update/${p.id}">${p.update ? 'Edit' : 'Complete update'}</a>` : `<a class="btn small quiet" href="#/projects/${p.id}?tab=updates">View</a>`}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="panel"><div class="empty"><b>No live projects</b>${mine.length ? '' : 'Weekly updates appear here once projects are on the register.'}</div></div>`}`);
  }

  async function updateForm(params, id) {
    const wk = params.get('week');
    const d = await api(`/projects/${id}/update${wk ? `?week=${wk}` : ''}`);
    const p = d.project, x = d.data, prev = d.previous ? d.previous.data : null;
    document.getElementById('vt').textContent = `Weekly update: ${p.name}`;
    document.getElementById('vc').textContent = `Week ending ${fDate(d.week)} · ${p.cm_name || ''}`;
    const n = (k, label, hint, extra = 'min="0" step="1"') => field(label, `<input type="number" inputmode="decimal" data-k="${k}" value="${esc(x[k] ?? '')}" ${extra}>`, hint);
    const pc = (k, label, hint) => n(k, label, hint, 'min="0" max="100" step="0.5"');
    const gbp = (k, label, hint) => n(k, label, hint, 'min="0" step="1"');
    const dt = (k, label, hint) => field(label, `<input type="date" data-k="${k}" value="${esc(x[k] ?? '')}">`, hint);
    const tx = (k, label, hint) => field(label, `<textarea data-k="${k}">${esc(x[k] ?? '')}</textarea>`, hint);
    const was = k => (prev && prev[k] != null ? `last week ${prev[k]}%` : '');
    setMain(`<div class="upd">
      ${d.week !== d.this_week ? `<div class="note warn">You are correcting the update for week ending ${fDate(d.week)}, not this week's.</div>` : ''}
      ${d.existing ? `<div class="note info">Already submitted by ${esc(d.existing.submitted_name || '')}, ${fDT(d.existing.updated_at)}. Saving again replaces it; the change is kept in the project history.</div>` : (prev ? '<div class="note info">Running totals are carried over from last week. Change only what has moved.</div>' : '')}
      <div class="panel"><h2><span>1</span>Programme</h2>
        <div class="row">${pc('planned_pct', 'Planned progress (%)', was('planned_pct'))}${pc('actual_pct', 'Actual progress (%)', was('actual_pct'))}${dt('forecast_completion', 'Forecast completion', p.planned_completion ? `planned ${fDate(p.planned_completion)}` : '')}</div>
        <div class="row">${tx('delay', 'Delays', 'what has slipped and why; leave empty if none')}${tx('recovery', 'Recovery actions', 'what is being done to pull it back')}</div></div>
      <div class="panel"><h2><span>2</span>Commercial</h2>
        <div class="row">${gbp('approved_variations', 'Approved variations to date (£)', p.contract_value ? `contract value ${money(p.contract_value)}` : '')}${gbp('forecast_cost', 'Forecast final cost (£)')}</div>
        <div class="calc" id="calc"></div>
        <div class="row">${gbp('applied', 'Applied for to date (£)')}${gbp('certified', 'Certified to date (£)')}${gbp('paid', 'Paid to date (£)')}</div>
        <div class="row">${gbp('overdue_amount', 'Payment overdue (£)', '0 if none')}${n('overdue_days', 'Days overdue')}</div>
        <div class="row">${n('unagreed_n', 'Variations not yet agreed', 'how many')}${gbp('unagreed_value', 'Their value (£)')}${n('notices_open', 'Contractual notices open')}</div>
        ${tx('commercial_risk', 'Commercial risks needing intervention', 'leave empty if none')}</div>
      <div class="panel"><h2><span>3</span>Health & safety</h2>
        <div class="row">${dt('audit_on', 'Site audit this week', 'date, if there was one')}${pc('audit_score', 'Audit score (%)')}${n('incidents', 'Incidents this week')}${n('near_misses', 'Near misses this week')}</div>
        <div class="row">${tx('critical_activities', 'Temporary works and critical activities', 'what is live or coming up next week')}${tx('safety_note', 'Anything else on safety', 'optional')}</div>
        <p class="small muted" style="margin:0">Findings, incidents and near misses go on the <a href="#/projects/${p.id}?tab=safety">safety register</a> with their detail and close-out date. An audit entered here is added to the register for you.</p></div>
      <div class="panel"><h2><span>4</span>Quality</h2>
        <div class="row">${pc('itp_planned_pct', 'Inspection and Test Plan: planned (%)', was('itp_planned_pct'))}${pc('itp_actual_pct', 'Inspection and Test Plan: actual (%)', was('itp_actual_pct'))}</div>
        <div class="row">${n('inspections_due', 'Inspections outstanding')}${n('tests_outstanding', 'Tests and certificates outstanding')}${n('handover_outstanding', 'Handover documents outstanding')}</div>
        ${tx('quality_risk', 'Quality risks to programme', 'leave empty if none')}
        <p class="small muted" style="margin:0">Hold points, non-conformance reports and defects go on the <a href="#/projects/${p.id}?tab=quality">quality register</a>.</p></div>
      <div class="panel"><h2><span>5</span>Management</h2>
        ${tx('summary', 'The week in a few lines')}
        <div class="row">${tx('issues', `Issues needing ${esc(brand.director)}`, 'leave empty if none')}${tx('decision', `Decision required from ${esc(brand.director)}`, 'leave empty if none')}</div></div>
      <div class="savebar"><span class="small muted" style="margin-right:auto">Week ending ${fDate(d.week)}</span><a class="btn ghost" href="#/projects/${p.id}">Cancel</a><button class="btn" id="save">${d.existing ? 'Save changes' : 'Submit update'}</button></div></div>`);
    const get = k => { const el = main().querySelector(`[data-k=${k}]`); return el.value === '' ? null : Number(el.value); };
    const calc = () => {
      const value = (p.contract_value || 0) + (get('approved_variations') || 0), cost = get('forecast_cost');
      document.getElementById('calc').textContent = value > 0 && cost != null ? `Forecast final value ${money(value)}, forecast cost ${money(cost)}: margin ${(Math.round(((value - cost) / value) * 1000) / 10)}%` : 'Enter the forecast final cost to see the margin.';
    };
    main().querySelectorAll('[data-k=approved_variations],[data-k=forecast_cost]').forEach(el => (el.oninput = calc)); calc();
    if (!canEdit()) { document.getElementById('save').disabled = true; return; }
    document.getElementById('save').onclick = async e => {
      const data = {}; main().querySelectorAll('[data-k]').forEach(el => (data[el.dataset.k] = el.value));
      e.target.disabled = true;
      try { await api(`/projects/${p.id}/update`, { method: 'PUT', body: { week_ending: d.week, data } }); pendingFlash = ['Weekly update saved.']; go(`#/projects/${p.id}`); }
      catch (err) { e.target.disabled = false; flash(err.message, 'err'); window.scrollTo(0, 0); }
    };
  }

  // ---------- safety and quality registers ----------
  let itemRows = [];
  function itemsTable(rows, showProject) {
    itemRows = rows;
    if (!rows.length) return '<div class="panel"><div class="empty"><b>Nothing recorded</b>Entries appear here as they are added.</div></div>';
    const t = todayIso();
    return `<div class="tablewrap"><table><thead><tr><th>Raised</th>${showProject ? '<th>Project</th>' : ''}<th>Type</th><th>Entry</th><th>Risk</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>
      ${rows.map(i => `<tr class="click" data-item="${i.id}"><td style="white-space:nowrap">${fDate(i.raised_on)}</td>${showProject ? `<td>${pname(i)}</td>` : ''}<td>${TYPE[i.type]}</td>
        <td><b>${esc(i.title)}</b>${i.type === 'audit' ? ` <span class="sub">${i.score}%</span>` : ''}${i.detail ? `<div class="sub">${esc(i.detail.length > 110 ? i.detail.slice(0, 110) + '…' : i.detail)}</div>` : ''}</td>
        <td>${i.type === 'audit' ? '' : `<span class="pill ${i.severity}">${i.severity}</span>`}</td><td>${esc(i.owner || '')}</td>
        <td style="white-space:nowrap">${fDate(i.due_on)}${i.status !== 'closed' && i.due_on && i.due_on < t ? ' <span class="pill overdue">Overdue</span>' : ''}</td>
        <td><span class="pill ${i.status}">${i.type === 'audit' ? 'recorded' : i.status}</span></td></tr>`).join('')}</tbody></table></div>`;
  }
  function bindItems(rows, edit) {
    main().querySelectorAll('[data-item]').forEach(tr => (tr.onclick = () => { const i = rows.find(x => x.id === Number(tr.dataset.item)); itemDialog(i, i.register, i.project_id, edit); }));
  }

  async function register(name, params) {
    const d = await api(`/items?register=${name}`);
    const ps = (await projects()).filter(p => p.status === 'live');
    const f = { project: params.get('project') || '', type: params.get('type') || '', show: params.get('show') || 'open' };
    const rows = d.rows.filter(i => (!f.project || String(i.project_id) === f.project) && (!f.type || i.type === f.type) && (f.show === 'all' || (i.status !== 'closed')));
    setMain(`<div class="toolbar">${field('Project', select('f_project', [['', 'All projects'], ...ps.map(p => [p.id, p.name])], f.project))}
        ${field('Type', select('f_type', [['', 'All types'], ...TYPES[name].map(t => [t, TYPE[t]])], f.type))}
        ${field('Show', select('f_show', [['open', 'Open only'], ['all', 'Everything, including closed and audits']], f.show))}
        ${canEdit() && ps.length ? '<button class="btn" id="add" style="margin-left:auto">Add entry</button>' : ''}</div>${itemsTable(rows, true)}`);
    ['project', 'type', 'show'].forEach(k => (document.getElementById('f_' + k).onchange = () => go(`#/${name}?project=${v('f_project')}&type=${v('f_type')}&show=${v('f_show')}`)));
    const add = document.getElementById('add'); if (add) add.onclick = () => itemDialog(null, name, f.project || null);
    bindItems(d.rows, canEdit());
  }

  async function itemDialog(i, registerName, projectId, edit = true) {
    const ps = (await projects()).filter(p => p.status === 'live' || (i && p.id === i.project_id));
    const isNew = !i; i = i || { type: TYPES[registerName][0], severity: 'low', status: 'open', raised_on: todayIso() };
    openDlg(isNew ? `Add to the ${registerName} register` : TYPE[i.type], `${isNew ? field('Project', select('i_project', [['', 'Choose'], ...ps.map(p => [p.id, p.name])], projectId)) : `<p class="muted small" style="margin-top:0">${esc((ps.find(p => p.id === i.project_id) || {}).name || '')} · recorded by ${esc(i.created_by || '')}</p>`}
      <div class="row">${field('Type', select('i_type', TYPES[registerName].map(t => [t, TYPE[t]]), i.type))}${field('Date', input('i_raised', i.raised_on, 'date'))}</div>
      ${field('Title', input('i_title', i.title))}${field('Detail', `<textarea id="i_detail">${esc(i.detail || '')}</textarea>`, 'optional')}
      <div class="row" id="i_auditrow">${field('Audit score (%)', input('i_score', i.score, 'number', 'min="0" max="100" step="0.5"'))}</div>
      <div id="i_rest"><div class="row">${field('Risk', select('i_severity', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], i.severity))}${field('Status', `<select id="i_status"></select>`)}</div>
      <div class="row">${field('Owner', input('i_owner', i.owner), 'who closes it out')}${field('Due', input('i_due', i.due_on, 'date'), 'close-out date')}</div>
      ${field('Close-out note', input('i_note', i.close_note), 'what was done')}</div>
      <div class="note warn hidden" id="i_warn"></div>`, edit ? `<button class="btn" id="save">${isNew ? 'Add entry' : 'Save'}</button>` : '');
    const sync = () => {
      const t = val('#i_type'), audit = t === 'audit', cur = $d('#i_status').value || i.status;
      $d('#i_auditrow').classList.toggle('hidden', !audit); $d('#i_rest').classList.toggle('hidden', audit);
      const opts = [['open', t === 'hold_point' || t === 'inspection' || t === 'test' ? 'Open (not yet passed)' : 'Open'], ...(CAN_FAIL.includes(t) ? [['failed', 'Failed']] : []), ['closed', CAN_FAIL.includes(t) ? 'Passed and closed' : 'Closed']];
      $d('#i_status').innerHTML = opts.map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${l}</option>`).join('');
      const esc_ = (t === 'incident' && val('#i_severity') === 'high') || (t === 'hold_point' && $d('#i_status').value === 'failed');
      $d('#i_warn').classList.toggle('hidden', !esc_);
      $d('#i_warn').textContent = `Saving this ${t === 'incident' ? 'high-risk incident' : 'failed hold point'} escalates it to ${brand.director} straight away.`;
    };
    ['#i_type', '#i_severity', '#i_status'].forEach(s => ($d(s).onchange = sync)); sync();
    if (!edit) return;
    $d('#save').onclick = async () => {
      const body = { register: registerName, project_id: isNew ? val('#i_project') : i.project_id, type: val('#i_type'), raised_on: val('#i_raised'), title: val('#i_title'), detail: val('#i_detail'), score: val('#i_score'),
        severity: val('#i_severity'), status: val('#i_status'), owner: val('#i_owner'), due_on: val('#i_due'), close_note: val('#i_note') };
      if (isNew && !body.project_id) return dlgErr('Choose the project.');
      try { const r = await api(isNew ? '/items' : `/items/${i.id}`, { method: isNew ? 'POST' : 'PUT', body }); dlg.close(); pendingFlash = [r.escalated ? `Saved and escalated to ${brand.director}.` : 'Saved.']; reload(); }
      catch (e) { dlgErr(e.message); }
    };
  }

  // ---------- action tracker ----------
  const AREA_NAME = Object.fromEntries(AREAS.map(a => [a[0], a[0] === 'management' ? 'Management' : a[1]]));
  function actionsTable(rows, showProject) {
    if (!rows.length) return '<div class="panel"><div class="empty"><b>No actions</b>Actions appear here as they are allocated.</div></div>';
    const t = todayIso();
    return `<div class="tablewrap"><table><thead><tr><th>Action</th>${showProject ? '<th>Project</th>' : ''}<th>Area</th><th>Responsible</th><th>Target date</th><th>Status</th></tr></thead><tbody>
      ${rows.map(a => `<tr class="click" data-action="${a.id}"><td><b>${esc(a.title)}</b>${a.needs_director ? ` <span class="pill under_review">For ${esc(brand.director)}</span>` : ''}${a.detail ? `<div class="sub">${esc(a.detail.length > 110 ? a.detail.slice(0, 110) + '…' : a.detail)}</div>` : ''}</td>
        ${showProject ? `<td>${a.project_id ? pname(a) : '<span class="muted">Division</span>'}</td>` : ''}<td>${AREA_NAME[a.area]}</td><td>${esc(a.owner_name || '')}</td>
        <td style="white-space:nowrap">${fDate(a.due_on)}</td><td>${a.status === 'done' ? `<span class="pill done">Done ${fDate(a.closed_on)}</span>` : a.due_on < t ? '<span class="pill overdue">Overdue</span>' : '<span class="pill open">Open</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function bindActions(rows) {
    main().querySelectorAll('[data-action]').forEach(tr => (tr.onclick = () => actionDialog(rows.find(x => x.id === Number(tr.dataset.action)), null)));
  }

  async function actionsView(params) {
    const d = await api('/actions');
    const ps = (await projects()).filter(p => p.status === 'live');
    const f = { project: params.get('project') || '', owner: params.get('owner') || '', show: params.get('show') || 'open' };
    const owners = [...new Set(d.rows.map(a => a.owner_name).filter(Boolean))].sort();
    const rows = d.rows.filter(a => (!f.project || String(a.project_id) === f.project) && (!f.owner || a.owner_name === f.owner) &&
      (f.show === 'all' || (f.show === 'open' && a.status === 'open') || (f.show === 'overdue' && a.status === 'open' && a.due_on < d.today) || (f.show === 'director' && a.status === 'open' && a.needs_director)));
    const overdue = d.rows.filter(a => a.status === 'open' && a.due_on < d.today).length;
    setMain(`${overdue ? `<div class="flag red" style="margin-bottom:1rem"><div><b>${overdue} action${overdue === 1 ? ' is' : 's are'} overdue.</b></div>${f.show === 'overdue' ? '' : '<a class="btn small ghost" href="#/actions?show=overdue">Show them</a>'}</div>` : ''}
      <div class="toolbar">${field('Project', select('f_project', [['', 'All projects'], ...ps.map(p => [p.id, p.name])], f.project))}
        ${field('Responsible', select('f_owner', [['', 'Everyone'], ...owners.map(o => [o, o])], f.owner))}
        ${field('Show', select('f_show', [['open', 'Open'], ['overdue', 'Overdue'], ['director', `For ${brand.director}`], ['all', 'Everything, including done']], f.show))}
        ${canEdit() ? '<button class="btn" id="add" style="margin-left:auto">Add action</button>' : ''}</div>${actionsTable(rows, true)}`);
    ['project', 'owner', 'show'].forEach(k => (document.getElementById('f_' + k).onchange = () => go(`#/actions?project=${v('f_project')}&owner=${encodeURIComponent(v('f_owner'))}&show=${v('f_show')}`)));
    const add = document.getElementById('add'); if (add) add.onclick = () => actionDialog(null, f.project || null);
    bindActions(d.rows);
  }

  async function actionDialog(a, projectId) {
    const [ps, ppl] = await Promise.all([projects(), people()]);
    const isNew = !a; a = a || { area: 'management', status: 'open' };
    const live = ps.filter(p => p.status === 'live');
    const edit = canEdit();
    openDlg(isNew ? 'Add action' : 'Action', `${isNew ? field('Project', select('a_project', [...(isAdmin() ? [['', 'Division (no single project)']] : [['', 'Choose']]), ...live.map(p => [p.id, p.name])], projectId))
        : `<p class="muted small" style="margin-top:0">${a.project_id ? esc((ps.find(p => p.id === a.project_id) || {}).name || '') : 'Division'} · raised by ${esc(a.created_by || '')}, ${fDate(a.created_at)}</p>`}
      ${field('Action', input('a_title', a.title))}${field('Detail', `<textarea id="a_detail">${esc(a.detail || '')}</textarea>`, 'optional')}
      <div class="row">${field('Responsible', select('a_owner', [['', 'Choose'], ...ppl.map(u => [u.id, u.name]), ...(a.owner_name && !a.owner_id ? [['x', a.owner_name]] : [])], a.owner_id || (a.owner_name ? 'x' : '')))}
        ${field('Target date', input('a_due', a.due_on, 'date'))}${field('Area', select('a_area', AREAS.map(x => [x[0], AREA_NAME[x[0]]]), a.area))}</div>
      <label class="check" style="margin-bottom:1rem"><input type="checkbox" id="a_dir" ${a.needs_director ? 'checked' : ''}>Needs ${esc(brand.director)}'s intervention or decision</label>
      ${isNew ? '' : `<div class="row">${field('Status', select('a_status', [['open', 'Open'], ['done', 'Done']], a.status))}${field('Completion note', input('a_note', a.close_note), 'what was done')}</div>`}`,
      edit ? `${!isNew && a.status === 'open' ? '<button class="btn ghost left" id="done">Mark done</button>' : ''}<button class="btn" id="save">${isNew ? 'Add action' : 'Save'}</button>` : '');
    if (!edit) return;
    const send = async status => {
      const o = val('#a_owner');
      const body = { project_id: isNew ? val('#a_project') : a.project_id, title: val('#a_title'), detail: val('#a_detail'), owner_id: o === 'x' ? null : o, owner_name: o === 'x' ? a.owner_name : null, due_on: val('#a_due'), area: val('#a_area'),
        needs_director: $d('#a_dir').checked, status: status || (isNew ? 'open' : val('#a_status')), close_note: isNew ? null : val('#a_note') };
      try { await api(isNew ? '/actions' : `/actions/${a.id}`, { method: isNew ? 'POST' : 'PUT', body }); dlg.close(); pendingFlash = [status === 'done' ? 'Action marked done.' : 'Saved.']; reload(); }
      catch (e) { dlgErr(e.message); }
    };
    $d('#save').onclick = () => send();
    if ($d('#done')) $d('#done').onclick = () => send('done');
  }

  // ---------- escalations ----------
  async function escalations() {
    const d = await api('/escalations');
    const open = d.rows.filter(e => !e.closed_at), closed = d.rows.filter(e => e.closed_at);
    const card = e => `<div class="panel" style="border-left:4px solid ${e.closed_at ? 'var(--line)' : 'var(--brick)'}"><div class="ad-head" style="margin:0;align-items:flex-start"><div><span class="k" ${e.closed_at ? '' : 'style="color:var(--brick)"'}>${esc(e.kind)}</span>
        <h2 style="margin:.15rem 0 .2rem">${esc(e.title)}</h2><p class="small muted" style="margin:0"><a href="#/projects/${e.project_id}">${pname(e)}</a> · raised by ${esc(e.raised_by || '')}, ${fDT(e.raised_at)}</p></div>
        <div>${e.closed_at ? `<span class="pill closed">Closed ${fDate(e.closed_at)}</span>` : e.acknowledged_at ? '<span class="pill under_review">Acknowledged</span>' : '<span class="pill failed">Waiting for a response</span>'}</div></div>
      ${e.detail ? `<p style="white-space:pre-wrap;margin:.7rem 0 0">${esc(e.detail)}</p>` : ''}
      ${e.acknowledged_at ? `<div class="said" style="margin-top:.8rem"><span class="k">Response from ${esc(e.acknowledged_by || '')}, ${fDT(e.acknowledged_at)}</span><p>${esc(e.response || 'Acknowledged.')}</p></div>` : ''}
      ${isAdmin() && !e.closed_at ? `<div style="margin-top:.8rem;display:flex;gap:.5rem"><button class="btn small" data-resp="${e.id}">${e.acknowledged_at ? 'Update response' : 'Acknowledge and respond'}</button><button class="btn small ghost" data-close-esc="${e.id}">Close</button></div>` : ''}</div>`;
    setMain(`<div class="ad-head"><div><p class="muted">Serious safety incidents, failed hold points and urgent contractual matters come here the moment they are raised${d.email ? `, and are emailed to ${esc(brand.director)}` : ''}.</p></div>${canEdit() ? '<button class="btn" id="add">Escalate now</button>' : ''}</div>
      ${open.length ? open.map(card).join('') : '<div class="panel"><div class="empty"><b>Nothing open</b>No escalations are waiting.</div></div>'}
      ${closed.length ? `<h2>Closed</h2>${closed.map(card).join('')}` : ''}`);
    const add = document.getElementById('add'); if (add) add.onclick = () => escalateDialog(null);
    const respond = (e, close) => {
      openDlg(close ? 'Close escalation' : 'Respond', `<p class="muted" style="margin-top:0">${esc(e.title)}</p>${field(close ? 'Outcome' : 'Response or decision', `<textarea id="e_resp">${esc(e.response || '')}</textarea>`)}`, `<button class="btn" id="save">${close ? 'Close escalation' : 'Save response'}</button>`);
      $d('#save').onclick = async () => { try { await api(`/escalations/${e.id}`, { method: 'PUT', body: { response: val('#e_resp'), close } }); dlg.close(); reload(); } catch (err) { dlgErr(err.message); } };
    };
    main().querySelectorAll('[data-resp]').forEach(b => (b.onclick = () => respond(d.rows.find(e => e.id === Number(b.dataset.resp)), false)));
    main().querySelectorAll('[data-close-esc]').forEach(b => (b.onclick = () => respond(d.rows.find(e => e.id === Number(b.dataset.closeEsc)), true)));
  }

  async function escalateDialog(projectId) {
    const ps = (await projects()).filter(p => p.status === 'live');
    const kinds = ['Safety incident', 'Failed hold point', 'Urgent contractual matter', 'Other urgent matter'];
    openDlg('Escalate now', `<p class="muted" style="margin-top:0">This goes to ${esc(brand.director)} straight away and stays on the dashboard until it is dealt with.</p>
      <div class="row">${field('Project', select('e_project', [['', 'Choose'], ...ps.map(p => [p.id, p.name])], projectId))}${field('What it is', select('e_kind', kinds.map(k => [k, k]), ''))}</div>
      ${field('What has happened', input('e_title', ''), 'one line')}${field('Detail', `<textarea id="e_detail"></textarea>`, 'what is known so far, and what is needed')}`, '<button class="btn danger" id="save">Escalate</button>');
    $d('#save').onclick = async () => {
      if (!val('#e_project')) return dlgErr('Choose the project.');
      try { await api('/escalations', { body: { project_id: val('#e_project'), kind: val('#e_kind'), title: val('#e_title'), detail: val('#e_detail') } }); dlg.close(); pendingFlash = [`Escalated to ${brand.director}.`]; go('#/escalations'); }
      catch (e) { dlgErr(e.message); }
    };
  }

  // ---------- weekly executive summary ----------
  async function report(params) {
    const d = await api(`/report${params.get('week') ? `?week=${params.get('week')}` : ''}`);
    const ps = d.projects, withRag = ps.filter(p => p.rag);
    const all = s => withRag.filter(p => AREAS.every(([k]) => p.rag[k].s === s));
    const flagged = k => withRag.filter(p => ['amber', 'red'].includes(p.rag[k].s)).sort((a, b) => (a.rag[k].s === 'red' ? 0 : 1) - (b.rag[k].s === 'red' ? 0 : 1));
    const head = p => `<b><a href="#/projects/${p.id}">${esc(p.name)}</a></b> <span class="sub">${[p.ref, p.cm_name].filter(Boolean).map(esc).join(' · ')}</span>`;
    const block = (k, quotes) => { const rows = flagged(k); return rows.length ? rows.map(p => { const ud = p.update ? p.update.data : {}; return `<div class="panel"><div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start"><div>${head(p)}</div>${ragPill(p.rag[k])}</div>
        <ul>${p.rag[k].why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>${quotes.map(([key, label]) => (ud[key] ? `<div class="quote"><span class="k">${label}</span><br>${esc(ud[key])}</div>` : '')).join('')}</div>`; }).join('') : '<p class="muted">None this week.</p>'; };
    const good = all('green'), missing = ps.filter(p => !p.update);
    const decisions = ps.filter(p => p.update && (p.update.data.decision || p.update.data.issues));
    const list = (rows, fn) => `<div class="tablewrap"><table><tbody>${rows.map(fn).join('')}</tbody></table></div>`;
    setMain(`<div class="rep"><div class="ad-head no-print"><div>${field('Week ending', select('wk', d.weeks.map(w => [w, fDate(w) + (w === d.this_week ? ' (this week)' : '')]), d.week))}</div><div><button class="btn ghost" id="print">Print or save as PDF</button></div></div>
      <div class="print-only"><h1>${esc(brand.name)} ${esc(brand.division)}: weekly executive summary</h1></div>
      <p class="muted">Week ending ${fDate(d.week)}. ${ps.length} live project${ps.length === 1 ? '' : 's'}; ${ps.length - missing.length} update${ps.length - missing.length === 1 ? '' : 's'} received. ${d.current ? `Position as at ${fDT(d.generated_at)}.` : 'Indicators shown as they stood that week.'}</p>
      ${ps.length ? `<div class="tablewrap"><table><thead><tr><th>Project</th><th>Contracts Manager</th>${AREAS.map(a => `<th>${a[1]}</th>`).join('')}</tr></thead><tbody>
        ${ps.map(p => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.cm_name || '')}</td>${p.rag ? AREAS.map(a => `<td class="rc">${ragPill(p.rag[a[0]])}</td>`).join('') : '<td colspan="5" class="muted">No update for this week</td>'}</tr>`).join('')}</tbody></table></div>` : '<div class="panel"><div class="empty"><b>No live projects</b>The summary fills in once projects are reporting.</div></div>'}
      <h2>Projects performing satisfactorily</h2>${good.length ? `<div class="panel">${good.map(p => `<div style="margin:.2rem 0">${head(p)}</div>`).join('')}</div>` : '<p class="muted">No project is green on all five indicators this week.</p>'}
      <h2>Projects behind programme</h2>${block('programme', [['delay', 'Delay'], ['recovery', 'Recovery']])}
      <h2>Commercial concerns</h2>${block('commercial', [['commercial_risk', 'Commercial risk']])}
      <h2>Significant safety findings</h2>${block('safety', [['critical_activities', 'Temporary works and critical activities'], ['safety_note', 'Note']])}
      ${d.current && d.safety_items.length ? list(d.safety_items, i => `<tr><td>${pname(i)}</td><td>${TYPE[i.type]}</td><td><b>${esc(i.title)}</b></td><td><span class="pill ${i.severity}">${i.severity}</span></td><td>${esc(i.owner || '')}</td><td>${i.due_on ? `due ${fDate(i.due_on)}${i.due_on < d.today ? ' <span class="pill overdue">Overdue</span>' : ''}` : ''}</td></tr>`) : ''}
      <h2>Quality failures and outstanding inspections</h2>${block('quality', [['quality_risk', 'Quality risk to programme']])}
      ${d.current && d.quality_items.length ? list(d.quality_items, i => `<tr><td>${pname(i)}</td><td>${TYPE[i.type]}</td><td><b>${esc(i.title)}</b></td><td><span class="pill ${i.status}">${i.status}</span></td><td>${esc(i.owner || '')}</td><td>${i.due_on ? `due ${fDate(i.due_on)}${i.due_on < d.today ? ' <span class="pill overdue">Overdue</span>' : ''}` : ''}</td></tr>`) : ''}
      <h2>Overdue management actions</h2>${d.current ? (d.overdue_actions.length ? list(d.overdue_actions, a => `<tr><td>${a.project_id ? pname(a) : 'Division'}</td><td><b>${esc(a.title)}</b></td><td>${esc(a.owner_name || '')}</td><td>due ${fDate(a.due_on)}</td></tr>`) : '<p class="muted">None.</p>') : block('management', [])}
      <h2>Decisions required from ${esc(brand.director)}</h2>
      ${d.current && d.escalations.length ? d.escalations.map(e => `<div class="panel" style="border-left:4px solid var(--brick)"><span class="k" style="color:var(--brick)">${esc(e.kind)}${e.acknowledged_at ? ' · acknowledged' : ' · waiting for a response'}</span><b>${pname(e)}: ${esc(e.title)}</b>${e.detail ? `<div class="quote">${esc(e.detail)}</div>` : ''}</div>`).join('') : ''}
      ${decisions.map(p => `<div class="panel">${head(p)}${p.update.data.decision ? `<div class="quote"><span class="k">Decision required</span><br>${esc(p.update.data.decision)}</div>` : ''}${p.update.data.issues ? `<div class="quote"><span class="k">Issue raised</span><br>${esc(p.update.data.issues)}</div>` : ''}</div>`).join('')}
      ${d.current && d.director_actions.length ? list(d.director_actions, a => `<tr><td>${a.project_id ? pname(a) : 'Division'}</td><td><b>${esc(a.title)}</b></td><td>${esc(a.owner_name || '')}</td><td>due ${fDate(a.due_on)}</td></tr>`) : ''}
      ${!decisions.length && !(d.current && (d.escalations.length || d.director_actions.length)) ? '<p class="muted">None this week.</p>' : ''}
      ${missing.length ? `<h2>No update received</h2><div class="panel">${missing.map(p => `<div style="margin:.2rem 0">${head(p)}</div>`).join('')}</div>` : ''}</div>`);
    document.getElementById('wk').onchange = () => go(`#/report?week=${v('wk')}`);
    document.getElementById('print').onclick = () => window.print();
  }

  // ---------- RAG rules ----------
  const RULE_TEXT = {
    programme: { slip: 'Progress behind plan (percentage points)', late_days: 'Forecast completion later than planned (days)', milestones: 'Milestones past their date' },
    commercial: { margin: 'Forecast margin below (%)', overdue_days: 'Payment overdue for (days)', unagreed_pct: 'Variations not yet agreed (% of contract value)', notices: 'Contractual notices open' },
    safety: { audit: 'Site audit score below (%)', high_open: 'High-risk items open', overdue: 'Corrective actions overdue', incidents: 'Incidents reported in the week' },
    quality: { failed: 'Failed hold points or inspections not yet closed', ncr: 'Non-conformance reports open', itp_slip: 'Inspection and Test Plan behind (percentage points)', inspections: 'Inspections outstanding', overdue: 'Quality items overdue' },
    management: { overdue_actions: 'Actions overdue', update_days: 'Days since the last weekly update' },
  };
  async function rules() {
    const d = await api('/rules');
    setMain(`<p class="muted">Each indicator takes the worst result of its checks: any check at its red level makes the indicator Red, any at its amber level makes it Amber, otherwise it is Green. An open escalation waiting for a response always shows Red on Management actions.</p>
      ${AREAS.map(([a, label]) => `<h2>${label}</h2><div class="tablewrap rules"><table><thead><tr><th>Check</th><th>Amber at</th><th>Red at</th></tr></thead><tbody>
        ${Object.entries(RULE_TEXT[a]).map(([k, text]) => `<tr><td>${text}</td><td><input type="number" min="0" step="0.5" data-rule="${a}.${k}_amber" value="${d.rules[a][k + '_amber']}"></td><td><input type="number" min="0" step="0.5" data-rule="${a}.${k}_red" value="${d.rules[a][k + '_red']}"></td></tr>`).join('')}</tbody></table></div>`).join('')}
      <div class="savebar"><button class="btn ghost" id="reset">Back to the standard thresholds</button><button class="btn" id="save">Save rules</button></div>`);
    const save = async rulesOut => { try { await api('/rules', { method: 'PUT', body: { rules: rulesOut } }); pendingFlash = ['RAG rules saved. Every indicator now uses them.']; reload(); } catch (e) { flash(e.message, 'err'); } };
    document.getElementById('save').onclick = () => { const out = {}; main().querySelectorAll('[data-rule]').forEach(el => { const [a, k] = el.dataset.rule.split('.'); (out[a] = out[a] || {})[k] = el.value; }); save(out); };
    document.getElementById('reset').onclick = () => { if (confirm('Put every threshold back to the standard setting?')) save(d.defaults); };
  }

  // ---------- audit trail ----------
  function auditTable(rows, showProject) {
    if (!rows.length) return '<div class="panel"><div class="empty"><b>Nothing yet</b>Every change is listed here as it happens.</div></div>';
    const change = det => (det && typeof det === 'object' ? Object.entries(det).filter(([, x]) => x && typeof x === 'object' && 'to' in x).map(([k, x]) => `${esc(k.replace(/_/g, ' '))}: ${esc(x.from ?? 'empty')} → ${esc(x.to ?? 'empty')}`).join('; ') : '');
    return `<div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th>${showProject ? '<th>Project</th>' : ''}<th>What</th></tr></thead><tbody>
      ${rows.map(a => `<tr><td style="white-space:nowrap">${fDT(a.at)}</td><td>${esc(a.user_name || '')}</td>${showProject ? `<td>${a.project_name ? pname(a) : ''}</td>` : ''}<td>${esc(a.summary || `${a.action} ${a.entity}`)}${change(a.detail) ? `<div class="sub">${change(a.detail)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }
  async function audit() {
    const d = await api('/audit');
    setMain(`<p class="muted">The latest 500 entries. Nothing here can be edited or removed.</p>${auditTable(d.rows, true)}`);
  }

  // ---------- users ----------
  async function users() {
    if (!isAdmin()) return setMain('<div class="note warn">Only a director login can manage users.</div>');
    const d = await api('/users');
    const roleName = { owner: 'Portal support', admin: 'Director (sees and changes everything)', manager: 'Contracts Manager (their own projects)', viewer: 'View only (every project)' };
    if (!isOwner()) delete roleName.owner;
    const short = { owner: 'Portal support', admin: 'Director', manager: 'Contracts Manager', viewer: 'View only' };
    setMain(`<div class="ad-head"><div><p class="muted">Everyone who logs in. A Contracts Manager sees and updates only the projects given to them.</p></div><button class="btn" id="add">Add user</button></div>
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Access</th><th></th></tr></thead><tbody>
        ${d.rows.map(u => `<tr><td><b>${esc(u.name)}</b>${u.active ? '' : ' <span class="pill grey">disabled</span>'}<div class="sub">${esc(u.job_title || '')}</div></td><td>${esc(u.email)}</td><td>${short[u.role]}</td>
          <td style="text-align:right"><button class="btn small quiet" data-u="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>`);
    const roles = sel => select('r', ['manager', 'admin', 'viewer', 'owner'].filter(k => roleName[k]).map(k => [k, roleName[k]]), sel);
    document.getElementById('add').onclick = () => {
      openDlg('Add user', `<div class="row">${field('Name', input('n', ''))}${field('Job title', input('j', ''), 'optional')}</div>${field('Email', input('e', '', 'email'))}${field('Access', roles('manager'))}
        ${field('Temporary password', input('p', ''), 'at least 8 characters; they change it after logging in')}`, '<button class="btn" id="save">Add user</button>');
      $d('#save').onclick = async () => {
        try { await api('/users', { body: { name: val('#n'), job_title: val('#j'), email: val('#e'), role: val('#r'), password: val('#p') } }); bust(); dlg.close(); users(); } catch (e) { dlgErr(e.message); }
      };
    };
    main().querySelectorAll('[data-u]').forEach(b => (b.onclick = () => {
      const u = d.rows.find(x => x.id === Number(b.dataset.u));
      openDlg(u.name, `<p class="muted" style="margin-top:0">${esc(u.email)}</p><div class="row">${field('Name', input('n', u.name))}${field('Job title', input('j', u.job_title))}</div>${field('Access', roles(u.role))}
        ${field('New password', input('p', ''), 'leave empty to keep the current one')}
        <label class="check"><input type="checkbox" id="act" ${u.active ? 'checked' : ''}>Can log in</label>`, '<button class="btn" id="save">Save</button>');
      $d('#save').onclick = async () => {
        try { await api(`/users/${u.id}`, { method: 'PUT', body: { name: val('#n'), job_title: val('#j') || '', role: val('#r'), password: val('#p') || undefined, active: $d('#act').checked } }); bust(); dlg.close(); users(); } catch (e) { dlgErr(e.message); }
      };
    }));
  }

  boot().catch(e => { root.innerHTML = `<div class="login-wrap"><div class="login-card"><div class="note err">${esc(e.message)}</div></div></div>`; });
})();
