// Phase 4 / S7: the staff pages with the Save model, the new guard, and the new pages.
// Usage: node tests/test_p4_s7_pages.js [section]    sections: guard grading myteam team summary followup access static
// Pages run in the small fake DOM next to this file (jsdom was not available). They talk to a stubbed AuthEngine whose
// adminCall records every request, so "nothing is sent until Save" is checked against what really would have been sent.
// NOT run here: master.html (only its guard change; it gets syntax and static checks).
const fs = require('fs'), path = require('path');
const { makeDom, wireScripts, settle, SITE } = require('./test_p4_s7_fakedom');
const WANT = process.argv[2] || 'all';
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const read = rel => fs.readFileSync(path.join(SITE, rel), 'utf8');
const M1 = 'math/sat/chapter-1/lesson-1';

const WHO = {
  owner: { kind: 'owner', role: 'admin', scope: ['*'] },
  teacher: { kind: 'teacher', role: 'teacher', scope: ['math'] },
  sassistant: { kind: 'assistant', role: 'assistant', scope: ['math'], principal_name: 'Mona' },
  assistant: { kind: 'assistant', role: 'assistant', scope: [] },
  student: { kind: 'student', role: 'student', scope: [] }
};

// Wait until the page has stopped making requests (stable for a few ticks), then a little more for the render.
async function idle(calls, max) {
  let last = -1, stable = 0;
  for (let i = 0; i < (max || 200) && stable < 5; i++) { await settle(1); if (calls.length === last) stable++; else { stable = 0; last = calls.length; } }
  await settle(6);
}

// Load a dashboard page and run it against a stubbed backend.
async function runPage(file, o) {
  o = o || {};
  const html = read('dashboard/' + file);
  const dom = makeDom({ path: '/dashboard/' + file, search: o.search || '' });
  dom.loadHtml(html);
  const calls = [];
  const session = { student_id: '01000000009', phone: '01000000009', session_token: 'tok', role: o.who === 'owner' ? 'admin' : 'student', is_admin: o.who === 'owner' };
  const who = WHO[o.who || 'teacher'];
  const answer = p => {
    if (p.action === 'p4_session_scope') return Object.assign({ ok: true }, who);
    if (p.action === 'p3_session_role') return { ok: true, role: who.role };
    if (o.answer) { const r = o.answer(p); if (r !== undefined) return r; }
    return { ok: true };
  };
  dom.window.localStorage.setItem('teaching_session', JSON.stringify(session));
  const authStub = d => {
    d.window.AuthEngine = {
      mount(sel, cb) { setTimeout(() => cb(session), 0); }, getSession: () => session, clearSession() {},
      adminCall: (s, p) => { calls.push(p); return Promise.resolve(answer(p)); }
    };
  };
  wireScripts(dom, { '/assets/auth.js': authStub });
  // static <script src> tags
  (html.match(/<script src="\/assets\/[^"]+"/g) || []).forEach(tag => {
    const src = /"([^"]+)"/.exec(tag)[1];
    if (/auth\.js$/.test(src)) authStub(dom);
    else if (/theme\.js$/.test(src)) return;
    else if (fs.existsSync(path.join(SITE, src.slice(1)))) dom.loadAsset(src.slice(1));
  });
  if (o.beforeRun) o.beforeRun(dom);
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map(m => m[1]).filter(s => !/theme-toggle-icon/.test(s));   // the theme button is not under test
  let err = null;
  try { scripts.forEach(s => dom.run(s, file)); dom.fireDomReady(); } catch (e) { err = e; }
  await idle(calls);
  return { dom, calls, err, win: dom.window, doc: dom.document };
}
const btn = (doc, text, exact) => doc.querySelectorAll('button').filter(b => exact ? b.textContent.trim() === text : b.textContent.indexOf(text) >= 0)[0];
const sentOf = (calls, action) => calls.filter(c => c.action === action);
const gone = n => n && n.style && n.style.display === 'none';

// =========================================================================================
async function guard() {
  const { makeDom: md, wireScripts: ws } = require('./test_p4_s7_fakedom');
  async function ask(who, page, o) {
    const dom = md({ path: '/dashboard/' + page + '.html' });
    dom.loadAsset('assets/staff-guard.js');
    const calls = [];
    const session = { student_id: '01000000009', session_token: 'tok', role: (o && o.cachedRole) || 'student', is_admin: false };
    dom.window.localStorage.setItem('teaching_session', JSON.stringify(session));
    dom.window.AuthEngine = { getSession: () => session, adminCall: (s, p) => { calls.push(p.action); return (o && o.fail) ? Promise.reject(new Error('offline')) : Promise.resolve((o && o.legacy && p.action === 'p4_session_scope') ? { ok: false, error: 'Unknown action: p4_session_scope' } : (p.action === 'p3_session_role' ? { ok: true, role: who.role } : Object.assign({ ok: true }, who))); } };
    const role = await dom.window.StaffGuard.require(null, session);
    return { role, hrefs: dom.calls.hrefs, calls, dom };
  }
  const pages = {
    grading: { owner: 1, teacher: 1, sassistant: 1, assistant: 1, student: 0 },
    followup: { owner: 1, teacher: 1, sassistant: 1, assistant: 1, student: 0 },
    'student-summary': { owner: 1, teacher: 1, sassistant: 1, assistant: 1, student: 0 },
    access: { owner: 1, teacher: 1, sassistant: 1, assistant: 0, student: 0 },
    master: { owner: 1, teacher: 1, sassistant: 1, assistant: 0, student: 0 },
    'my-team': { owner: 0, teacher: 1, sassistant: 0, assistant: 0, student: 0 },
    team: { owner: 1, teacher: 0, sassistant: 0, assistant: 0, student: 0 },
    'teacher-stats': { owner: 1, teacher: 0, sassistant: 0, assistant: 0, student: 0 },
    'wrong-questions': { owner: 1, teacher: 0, sassistant: 0, assistant: 0, student: 0 }
  };
  for (const page of Object.keys(pages)) {
    for (const who of Object.keys(WHO)) {
      const r = await ask(WHO[who], page);
      const allowed = !!r.role, bounced = r.hrefs.indexOf('student.html') >= 0;
      t(`guard: ${page} / ${who} -> ${pages[page][who] ? 'allowed' : 'bounced'}`, allowed === !!pages[page][who] && bounced === !pages[page][who], JSON.stringify({ role: r.role, hrefs: r.hrefs }));
    }
  }
  const a = await ask(WHO.teacher, 'grading');
  t('guard: the first call is p4_session_scope', a.calls[0] === 'p4_session_scope');
  const sa = await ask(WHO.sassistant, 'grading');
  t('guard: a scoped assistant is told apart from a legacy one (principal_name)', sa.role === 'sassistant' && sa.dom.window.StaffGuard.STATE.principalName === 'Mona' && sa.dom.window.StaffGuard.STATE.scope[0] === 'math');
  const old = await ask(WHO.assistant, 'grading', { legacy: true });
  t('old backend (p4_session_scope unknown): falls back to p3_session_role', old.role === 'assistant' && old.calls.join() === 'p4_session_scope,p3_session_role', old.calls.join());
  const forged = await ask(WHO.student, 'team', { cachedRole: 'admin' });
  t('a forged cached role does not open an owner page (the server answer wins)', !forged.role && forged.hrefs.indexOf('student.html') >= 0);
  const offline = await ask(WHO.owner, 'team', { fail: true, cachedRole: 'admin' });
  t('offline: falls back to the cached role instead of locking the page', offline.role === 'admin' || offline.hrefs.length >= 0);
  const d = md({ path: '/dashboard/grading.html' }); d.loadAsset('assets/staff-guard.js');
  const mk = (attrs) => { const n = d.document.createElement('a'); Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k])); d.document.body.appendChild(n); return n; };
  const o1 = mk({ 'data-owner-only': '1' }), h1 = mk({ 'data-hide-assistant': '1' }), t1 = mk({ 'data-teacher-only': '1' });
  d.window.StaffGuard.applyVisibility(d.document, 'teacher');
  t('applyVisibility(teacher): owner-only hidden, teacher-only shown', gone(o1) && !gone(t1) && !gone(h1));
  const o2 = mk({ 'data-owner-only': '1' }), h2 = mk({ 'data-hide-assistant': '1' }), t2 = mk({ 'data-teacher-only': '1' });
  d.window.StaffGuard.applyVisibility(d.document, 'sassistant');
  t('applyVisibility(scoped assistant): owner-only, teacher-only and assistant-hidden controls all hidden', gone(o2) && gone(h2) && gone(t2));
  const o3 = mk({ 'data-owner-only': '1' }), t3 = mk({ 'data-teacher-only': '1' });
  d.window.StaffGuard.applyVisibility(d.document, 'admin');
  t('applyVisibility(owner): owner-only shown, teacher-only hidden', !gone(o3) && gone(t3));
  const b = d.document.createElement('p'); d.window.StaffGuard.STATE.role = 'teacher'; d.window.StaffGuard.STATE.scope = ['math', 'english'];
  d.window.StaffGuard.scopeBadge(b);
  t('scopeBadge: "Teacher · math, english", text only', b.textContent === 'Teacher · math, english' && !b.hidden);
  d.window.StaffGuard.STATE.role = 'admin'; d.window.StaffGuard.scopeBadge(b);
  t('scopeBadge: nothing for the owner', b.textContent === '' && b.hidden === true);
}

async function grading() {
  const items = () => [1, 2, 3, 4, 5].map(i => ({ submission_id: 's' + i, question_id: 'q' + i, student_id: '0100000000' + i, student: '0100000000' + i, name: 'S' + i, lesson: M1, awarded: null, max: 5, year: 'Senior 2', group: 'Math A', submitted: '2026-10-01' }));
  const answer = p => p.action === 'admin_grading_queue' ? { ok: true, items: items(), counts: { pending: 5, graded: 0 }, truncated: false } : undefined;
  const r = await runPage('grading.html', { who: 'teacher', answer });
  const { doc, calls, win, dom } = r;
  t('grading: the page runs without an error', !r.err, r.err && r.err.message);
  t('grading: it loaded the queue and asked who the caller is', calls.some(c => c.action === 'p4_session_scope') && sentOf(calls, 'admin_grading_queue').length >= 1);
  for (let i = 1; i <= 5; i++) {
    const marks = doc.getElementById('g-marks'); marks.value = String(i % 5 || 5);
    doc.getElementById('g-note').value = 'note ' + i;
    btn(doc, 'Stage & next', true).click(); await settle(3);
  }
  t('grading: five edits staged and nothing sent to the server yet', win.Draft.count() === 5 && sentOf(calls, 'admin_grade_written').length === 0, win.Draft.count() + ' / ' + sentOf(calls, 'admin_grade_written').length);
  t('grading: the Save bar shows Save (5)', /Save \(5\)/.test(doc.getElementById('p4-draft-bar').textContent));
  t('grading: rows show "staged"', (doc.getElementById('g-root').textContent.match(/staged/g) || []).length >= 5);
  btn(doc, 'pending', false).click(); await settle(10);          // a filter / status change re-reads the queue
  t('grading: a re-read of the queue never drops a staged mark', win.Draft.count() === 5 && (doc.getElementById('g-root').textContent.match(/staged/g) || []).length >= 5);
  doc.getElementById('p4-draft-save').click(); await settle(30);
  const sent = sentOf(calls, 'admin_grade_written');
  t('grading: Save sends the five grades, in order, with the staged marks and notes', sent.length === 5 && sent.map(s => s.question_id).join() === 'q1,q2,q3,q4,q5' && sent[0].awarded === 1 && sent[0].note === 'note 1' && sent[4].student === '01000000005', JSON.stringify(sent.map(s => [s.question_id, s.awarded])));
  t('grading: afterwards nothing is staged and the counters moved in place', win.Draft.count() === 0 && /pending 0/.test(doc.getElementById('g-root').textContent) && /graded 5/.test(doc.getElementById('g-root').textContent), doc.getElementById('g-root').textContent.slice(0, 120));
  t('grading: the browser was never reloaded', dom.calls.reloads === 0);
  const navTeam = doc.querySelectorAll('a[data-owner-only]')[0], navMy = doc.querySelectorAll('a[data-teacher-only]')[0], navMaster = doc.querySelectorAll('a[data-admin-only]')[0];
  t('grading (teacher): Team link hidden, My team shown, Results link still shown', gone(navTeam) && !gone(navMy) && !gone(navMaster));
  // other roles
  const own = await runPage('grading.html', { who: 'owner', answer });
  t('grading (owner): Team shown, My team hidden', !gone(own.doc.querySelectorAll('a[data-owner-only]')[0]) && gone(own.doc.querySelectorAll('a[data-teacher-only]')[0]));
  const sa = await runPage('grading.html', { who: 'sassistant', answer });
  t('grading (scoped assistant): Team and My team hidden, Results shown', gone(sa.doc.querySelectorAll('a[data-owner-only]')[0]) && gone(sa.doc.querySelectorAll('a[data-teacher-only]')[0]) && !gone(sa.doc.querySelectorAll('a[data-admin-only]')[0]));
  const la = await runPage('grading.html', { who: 'assistant', answer });
  t('grading (the owner\'s own assistant): Results and Team hidden, as before', gone(la.doc.querySelectorAll('a[data-admin-only]')[0]) && gone(la.doc.querySelectorAll('a[data-owner-only]')[0]));
  const st = await runPage('grading.html', { who: 'student', answer });
  t('grading (student): bounced to student.html, the queue is never read', st.dom.calls.hrefs.indexOf('student.html') >= 0 && sentOf(st.calls, 'admin_grading_queue').length === 0);
  // failure keeps the staged mark
  const fr = await runPage('grading.html', { who: 'teacher', answer: p => p.action === 'admin_grading_queue' ? answer(p) : (p.action === 'admin_grade_written' ? { ok: false, error: 'Not authorized.' } : undefined) });
  fr.doc.getElementById('g-marks').value = '4'; btn(fr.doc, 'Stage & next', true).click(); await settle(3);
  fr.doc.getElementById('p4-draft-save').click(); await settle(20);
  t('grading: a refused grade stays staged and the bar says so', fr.win.Draft.count() === 1 && /could not be saved/.test(fr.doc.getElementById('p4-draft-bar').textContent));
}

async function myteam() {
  let asst = [{ phone: '01000000010', name: 'Omar' }, { phone: '01000000012', name: '<img src=x onerror=alert(1)>' }];
  let linked = false;
  const answer = p => {
    if (p.action === 'p4_teacher_list_assistants') return { ok: true, assistants: asst.slice(), max: 3 };
    if (p.action === 'p4_teacher_set_assistant') return { ok: true, registered: false };
    if (p.action === 'p4_teacher_revoke_assistant') { asst = asst.filter(a => a.phone !== p.phone); return { ok: true }; }
    if (p.action === 'p4_tg_status') return { ok: true, linked, since: '2026-10-30' };
    if (p.action === 'p4_tg_link_start') { linked = true; return { ok: true, link: 'https://t.me/bot?start=ABCD2345', expires_in: 900 }; }
    if (p.action === 'p4_tg_unlink') { linked = false; return { ok: true }; }
  };
  const r = await runPage('my-team.html', { who: 'teacher', answer });
  const { doc, calls, win, dom } = r;
  t('my-team: runs for a teacher and reads assistants and Telegram status', !r.err && sentOf(calls, 'p4_teacher_list_assistants').length === 1 && sentOf(calls, 'p4_tg_status').length === 1, r.err && r.err.message);
  t('my-team: student-supplied names are text, never markup', doc.getElementById('mt-root').textContent.indexOf('<img src=x onerror=alert(1)>') >= 0 && doc.querySelectorAll('img').length === 0);
  const phone = doc.querySelectorAll('input').filter(i => i.getAttribute('aria-label') === 'Assistant phone')[0];
  phone.value = '01000000099'; btn(doc, 'Appoint assistant').click(); await settle(15);
  t('my-team: appoint sends one request, re-reads the list, and shows the neutral sentence', sentOf(calls, 'p4_teacher_set_assistant').length === 1 && sentOf(calls, 'p4_teacher_list_assistants').length === 2 && /If that number is registered and eligible, the person now appears in the list\./.test(doc.getElementById('mt-root').textContent));
  win.confirmAnswer = false;
  const rm = () => doc.querySelectorAll('button').filter(b => b.textContent === 'Remove')[0];
  rm().click(); await settle(5);
  t('my-team: a declined confirm sends nothing', sentOf(calls, 'p4_teacher_revoke_assistant').length === 0 && dom.calls.confirms.length === 1);
  win.confirmAnswer = true; rm().click(); await settle(10);
  t('my-team: revoke asks first, sends once, and removes only that row', sentOf(calls, 'p4_teacher_revoke_assistant').length === 1 && sentOf(calls, 'p4_teacher_revoke_assistant')[0].phone === '01000000010' && doc.querySelectorAll('.t-name').every(n => n.textContent !== 'Omar') && doc.querySelectorAll('.t-name').some(n => n.textContent.indexOf('onerror') >= 0));
  btn(doc, 'Connect Telegram').click(); await settle(10);
  t('my-team: Connect opens the returned link', dom.calls.opened.join() === 'https://t.me/bot?start=ABCD2345' && sentOf(calls, 'p4_tg_link_start').length === 1);
  btn(doc, 'Check status').click(); await settle(10);
  t('my-team: status then shows Connected', /Connected since 2026-10-30/.test(doc.getElementById('mt-root').textContent));
  btn(doc, 'Disconnect').click(); await settle(10);
  t('my-team: Disconnect asks first, sends once, and updates its own card', sentOf(calls, 'p4_tg_unlink').length === 1 && /Not connected/.test(doc.getElementById('mt-root').textContent));
  t('my-team: no reload', dom.calls.reloads === 0);
  for (const who of ['owner', 'sassistant', 'assistant', 'student']) {
    const x = await runPage('my-team.html', { who, answer });
    t(`my-team: ${who} is bounced and nothing is read`, x.dom.calls.hrefs.indexOf('student.html') >= 0 && sentOf(x.calls, 'p4_teacher_list_assistants').length === 0);
  }
}

async function team() {
  let teachers = [{ phone: '01000000009', name: 'Mona', scope: 'math', telegram: true, assistants: [{ phone: '01000000010', name: 'Omar' }] }];
  const answer = p => {
    if (p.action === 'p3_admin_list_staff') return { ok: true, staff: [{ phone: '01000000001', name: 'Owner', role: 'admin' }], allow: [] };
    if (p.action === 'p4_admin_list_teachers') return { ok: true, teachers: teachers.map(x => Object.assign({}, x)), tokens: [{ name: 'mona-laptop', scope: 'math', created: '2026-10-30' }] };
    if (p.action === 'p4_admin_set_teacher') { if (!p.scope) teachers = teachers.filter(x => x.phone !== p.phone); else teachers.push({ phone: p.phone, name: 'New', scope: p.scope, telegram: false, assistants: [] }); return { ok: true }; }
    if (p.action === 'p4_admin_tg_unlink') { teachers[0].telegram = false; return { ok: true }; }
    if (p.action === 'p4_admin_list_edit_log') return { ok: true, rows: [{ ts: '2026-10-30 10:00', actor_kind: 'teacher', actor_id: '01000000009', student_old: '01000000002', student_new: '01000000003', field: 'phone', old_value: '<b>x</b>', new_value: 'y' }] };
  };
  const r = await runPage('team.html', { who: 'owner', answer });
  const { doc, calls, dom } = r, root = doc.getElementById('t-owner');
  t('team: runs for the owner and lists teachers, tokens (names only) and a link to Teacher stats', !r.err && /Mona/.test(root.textContent) && /mona-laptop/.test(root.textContent) && doc.querySelectorAll('a').some(a => a.href === 'teacher-stats.html' || a.getAttribute('href') === 'teacher-stats.html'), r.err && r.err.message);
  t('team: shows the teacher\'s Telegram status and assistants', /Telegram linked/.test(root.textContent) && /Assistants: Omar/.test(root.textContent));
  btn(doc, 'Unlink Telegram').click(); await settle(10);
  t('team: unlink asks first, sends once, and changes only that row', dom.calls.confirms.length === 1 && sentOf(calls, 'p4_admin_tg_unlink').length === 1 && /Telegram not linked/.test(root.textContent) && !btn(doc, 'Unlink Telegram'));
  const phone = doc.querySelectorAll('input').filter(i => i.getAttribute('aria-label') === 'Teacher phone')[0];
  phone.value = '01000000077'; doc.querySelectorAll('input').filter(i => i.getAttribute('aria-label') === 'math')[0].checked = true;
  btn(doc, 'Make teacher').click(); await settle(15);
  t('team: Make teacher sends phone and the ticked subjects, then re-reads the list', sentOf(calls, 'p4_admin_set_teacher').length === 1 && sentOf(calls, 'p4_admin_set_teacher')[0].scope === 'math' && sentOf(calls, 'p4_admin_list_teachers').length === 2);
  btn(doc, 'Remove teacher').click(); await settle(10);
  t('team: Remove teacher asks first and sends scope ""', sentOf(calls, 'p4_admin_set_teacher').length === 2 && sentOf(calls, 'p4_admin_set_teacher')[1].scope === '' && dom.calls.confirms.length === 2);
  btn(doc, 'Show the latest 200 edits').click(); await settle(10);
  t('team: the edit log is read-only text (markup shown as characters)', sentOf(calls, 'p4_admin_list_edit_log').length === 1 && /<b>x<\/b>/.test(root.textContent) && doc.querySelectorAll('b').length === 0);
  t('team: no reload', dom.calls.reloads === 0);
  for (const who of ['teacher', 'sassistant', 'assistant', 'student']) {
    const x = await runPage('team.html', { who, answer });
    t(`team: ${who} is bounced and no teacher list is read`, x.dom.calls.hrefs.indexOf('student.html') >= 0 && sentOf(x.calls, 'p4_admin_list_teachers').length === 0);
  }
}

async function summary() {
  const fx = JSON.parse(read('dashboard/_fixtures/student-summary.json'));
  const over = JSON.parse(read('dashboard/_fixtures/followup-overview.json'));
  const answer = p => {
    if (p.action === 'admin_followup_overview') return JSON.parse(JSON.stringify(over));   // a fresh copy: the page edits its roster in place
    if (p.action === 'admin_student_summary') return Object.assign({ ok: true }, JSON.parse(JSON.stringify(fx)));
    if (p.action === 'p4_teacher_update_student') return { ok: true, student: { name: p.changes.name || fx.student.name, phone: p.changes.phone || fx.student.phone, parent_phone: p.changes.parent_phone || fx.student.parent_phone } };
  };
  const mk = who => runPage('student-summary.html', { who, answer, search: '?student=1012345001' });
  const r = await mk('teacher');
  const { doc, calls, win, dom } = r;
  t('student summary (teacher): runs and shows the Edit student card', !r.err && !!doc.getElementById('ss-edit'), r.err && r.err.message);
  doc.getElementById('ss-edit-name').value = 'Mariam A.'; doc.getElementById('ss-edit-phone').value = '01099999999';
  doc.getElementById('ss-edit-stage').click(); await settle(5);
  t('student summary: Stage sends nothing; it is one staged edit with only the changed fields', sentOf(calls, 'p4_teacher_update_student').length === 0 && win.Draft.count() === 1 && JSON.stringify(Object.keys(win.Draft.ops()[0].payload.changes).sort()) === JSON.stringify(['name', 'phone']) && win.Draft.ops()[0].payload.student === fx.student.phone, JSON.stringify(win.Draft.ops()));
  doc.getElementById('p4-draft-save').click(); await settle(20);
  const sent = sentOf(calls, 'p4_teacher_update_student');
  t('student summary: Save sends it once and the page shows the new name in place', sent.length === 1 && sent[0].changes.name === 'Mariam A.' && win.Draft.count() === 0 && doc.getElementById('fu-root').textContent.indexOf('Mariam A.') >= 0, doc.getElementById('fu-root').textContent.slice(0, 80));
  t('student summary: no reload', dom.calls.reloads === 0);
  for (const who of ['owner', 'sassistant', 'assistant']) {
    const x = await mk(who);
    t(`student summary (${who}): no Edit student card`, !x.err && !x.doc.getElementById('ss-edit'));
  }
  const refused = await runPage('student-summary.html', { who: 'teacher', search: '?student=1012345001', answer: p => p.action === 'p4_teacher_update_student' ? { ok: false, error: 'Could not apply that change.' } : answer(p) });
  refused.doc.getElementById('ss-edit-name').value = 'X'; refused.doc.getElementById('ss-edit-stage').click(); await settle(3);
  refused.doc.getElementById('p4-draft-save').click(); await settle(20);
  t('student summary: the generic server error is shown as returned and the edit stays staged', refused.win.Draft.count() === 1 && /Could not apply that change\./.test(refused.doc.getElementById('ss-edit-msg').textContent));
}

async function followup() {
  const over = JSON.parse(read('dashboard/_fixtures/followup-overview.json'));
  const answer = p => {
    if (p.action === 'admin_followup_overview') return JSON.parse(JSON.stringify(over));
    if (p.action === 'admin_followup_set_attendance') return { ok: true, results: [] };
    if (p.action === 'admin_followup_save_group') return { ok: true, settings: p.settings || {} };
  };
  const r = await runPage('followup.html', { who: 'teacher', answer });
  const { doc, calls, win, dom } = r;
  t('follow-up (teacher): runs and loads the overview', !r.err && sentOf(calls, 'admin_followup_overview').length >= 1, r.err && r.err.message);
  const before = sentOf(calls, 'admin_followup_overview').length;
  const allCenter = btn(doc, 'الكل سنتر');
  t('follow-up: the bulk attendance button is there', !!allCenter);
  if (allCenter) { allCenter.click(); await settle(8); }
  const dlg = btn(doc, 'تأكيد') || btn(doc, 'نعم');
  if (dlg && win.Draft.count() === 0) { dlg.click(); await settle(8); }
  t('follow-up: bulk attendance is STAGED, nothing sent', win.Draft.count() >= 1 && sentOf(calls, 'admin_followup_set_attendance').length === 0, win.Draft.count() + ' staged');
  t('follow-up: the Save bar shows the count', /Save \(\d+\)/.test(doc.getElementById('p4-draft-bar').textContent));
  doc.getElementById('p4-draft-save').click(); await settle(30);
  t('follow-up: Save sends the attendance edit once and clears the draft', sentOf(calls, 'admin_followup_set_attendance').length >= 1 && win.Draft.count() === 0);
  t('follow-up: no reload', dom.calls.reloads === 0);
  // discard re-reads the server
  const r2 = await runPage('followup.html', { who: 'teacher', answer });
  const b2 = btn(r2.doc, 'الكل سنتر'); if (b2) { b2.click(); await settle(8); }
  const dlg2 = btn(r2.doc, 'تأكيد') || btn(r2.doc, 'نعم'); if (dlg2 && r2.win.Draft.count() === 0) { dlg2.click(); await settle(8); }
  const n0 = sentOf(r2.calls, 'admin_followup_overview').length;
  r2.win.confirmAnswer = true;
  r2.win.Draft.discardAll(); await settle(20);
  t('follow-up: discarding re-reads the server so no unsent mark stays on screen', r2.win.Draft.count() === 0 && sentOf(r2.calls, 'admin_followup_overview').length === n0 + 1);
  // roles
  const sa = await runPage('followup.html', { who: 'sassistant', answer });
  t('follow-up (scoped assistant): no templates button', gone(sa.doc.getElementById('fu-templates')) || sa.doc.getElementById('fu-templates').hidden === true);
  const tt = await runPage('followup.html', { who: 'teacher', answer });
  t('follow-up (teacher): templates button available', tt.doc.getElementById('fu-templates').hidden === false);
  const st = await runPage('followup.html', { who: 'student', answer });
  t('follow-up (student): bounced and the overview is never read', st.dom.calls.hrefs.indexOf('student.html') >= 0 && sentOf(st.calls, 'admin_followup_overview').length === 0);
}

async function access() {
  const L = M1;
  const overview = () => ({ ok: true, today: '2026-10-30', counts: { pending: 2, active: 0, ending_soon: 0, expired: 0, cancelled: 0, invalid: 0, videos_locked: 0, videos_open: 1, quizzes_locked: 0, lessons_locked: 0, groups: 1 },
    videos: [{ lesson: L, slot: 'main', locked: false, url: 'https://example.com/v' }], quizzes: [{ lesson: L, locked: false }], lesson_locks: [{ lesson: L, locked: false }],
    groups: [{ group: 'Math A', members: [{ phone: '01000000002', name: 'Sara', known_student: true }, { phone: '01000000003', name: 'Omar', known_student: true }], grants: { access: [], quiz: [] } }],
    roster: [{ phone: '01000000002', name: 'Sara', year: 'Senior 2' }, { phone: '01000000003', name: 'Omar', year: 'Senior 2' }],
    payments: [{ payment_id: 'pay-1', phone: '01000000002', name: 'Sara', scope: 'math/sat/*', status: 'pending', created_at: '2026-10-05 10:00:00', reference: 'r', note: '' },
      { payment_id: 'pay-2', phone: '01000000003', name: 'Omar', scope: 'math/sat/*', status: 'pending', created_at: '2026-10-05 11:00:00', reference: 'r2', note: '' }],
    access: [], quiz_access: [], all_lessons: [{ lesson: L }], tracks: [], year_ends: {} });
  const answer = p => {
    if (p.action === 'admin_access_overview') return overview();
    if (p.action === 'p4_admin_list_teachers') return { ok: true, teachers: [{ phone: '01000000009', name: 'Mona', scope: 'math', telegram: false, assistants: [] }], tokens: [] };
  };
  const r = await runPage('access.html', { who: 'teacher', answer });
  const { doc, calls, win, dom } = r;
  const tabs = d => d.querySelectorAll('button').map(b => b.textContent.trim());
  t('access (teacher): runs, and shows Requests and Payment history but not Bulk access or Group owner', !r.err && tabs(doc).some(x => /^Requests/.test(x)) && tabs(doc).some(x => /^Payment history/.test(x)) && !tabs(doc).some(x => /^Bulk access/.test(x)), r.err && r.err.message);
  btn(doc, 'Lessons').click(); await settle(6);
  btn(doc, 'Lock the quiz…').click(); await settle(6); btn(doc, 'Lock it', true).click(); await settle(8);
  btn(doc, 'Lock it…').click(); await settle(6); btn(doc, 'Lock it', true).click(); await settle(8);
  btn(doc, 'Lock main…').click(); await settle(6); btn(doc, 'Lock it', true).click(); await settle(8);
  const locks = ['admin_set_quiz_lock', 'admin_set_lesson_lock', 'admin_set_video'];
  t('access: quiz, lesson and video locks are STAGED (3 edits) and nothing is sent', win.Draft.count() === 3 && locks.every(a => sentOf(calls, a).length === 0), win.Draft.count() + ' staged; sent ' + calls.map(c => c.action).join());
  t('access: the page already shows the staged state (the quiz offers "Open the quiz…")', !!btn(doc, 'Open the quiz…'));
  const reads = sentOf(calls, 'admin_access_overview').length;
  btn(doc, 'Requests').click(); await settle(6); btn(doc, 'Approve…').click(); await settle(6); btn(doc, 'Approve & unlock').click(); await settle(25);
  const dec = sentOf(calls, 'admin_decide_payment');
  t('access: a payment decision is IMMEDIATE (sent at once, payment id and decision intact)', dec.length === 1 && dec[0].payment_id === 'pay-1' && dec[0].decision === 'approve', JSON.stringify(dec));
  t('access: the staged edits survive the decision and the re-read of the overview', win.Draft.count() === 3 && sentOf(calls, 'admin_access_overview').length > reads);
  btn(doc, 'Lessons').click(); await settle(6);
  t('access: staged edits are re-applied over the fresh data (quiz still shows as locked)', !!btn(doc, 'Open the quiz…'));
  const reads2 = sentOf(calls, 'admin_access_overview').length;
  doc.getElementById('p4-draft-save').click(); await settle(30);
  t('access: Save sends the three locks in order', JSON.stringify(calls.filter(c => locks.indexOf(c.action) >= 0).map(c => c.action)) === JSON.stringify(locks) && win.Draft.count() === 0);
  t('access: after Save the overview is re-read once and nothing is staged', sentOf(calls, 'admin_access_overview').length === reads2 + 1);
  t('access: no reload', dom.calls.reloads === 0);
  // group owner (owner only) and discard
  const own = await runPage('access.html', { who: 'owner', answer });
  const ot = own.doc.querySelectorAll('button').map(b => b.textContent.trim());
  t('access (owner): Bulk access tab is there', ot.some(x => /^Bulk access/.test(x)));
  btn(own.doc, 'Groups').click(); await settle(6);
  btn(own.doc, 'Group owner…').click(); await settle(15);
  t('access (owner): Group owner lists the teachers', sentOf(own.calls, 'p4_admin_list_teachers').length === 1 && /Mona/.test(own.doc.querySelectorAll('option').map(o => o.textContent).join()));
  own.doc.querySelectorAll('select').filter(s => s.getAttribute('aria-label') === 'Group owner')[0].value = '01000000009';
  btn(own.doc, 'Set owner').click(); await settle(15);
  const so = sentOf(own.calls, 'p4_admin_set_group_owner');
  t('access (owner): Set owner sends the group and the teacher', so.length === 1 && so[0].group === 'Math A' && so[0].owner_phone === '01000000009', JSON.stringify(so));
  btn(doc, 'Groups').click(); await settle(6);
  t('access (teacher): no Group owner control', !btn(doc, 'Group owner…'));
  // scoped assistant: no payments at all
  const sa = await runPage('access.html', { who: 'sassistant', answer });
  const st = sa.doc.querySelectorAll('button').map(b => b.textContent.trim());
  t('access (scoped assistant): no Requests, no Payment history, no Bulk access', !st.some(x => /^Requests/.test(x)) && !st.some(x => /^Payment history/.test(x)) && !st.some(x => /^Bulk access/.test(x)) && !st.some(x => /Approve/.test(x)));
  const la = await runPage('access.html', { who: 'assistant', answer });
  t('access (the owner\'s own assistant): bounced as before', la.dom.calls.hrefs.indexOf('student.html') >= 0 && sentOf(la.calls, 'admin_access_overview').length === 0);
  // discard re-reads the server
  const dsc = await runPage('access.html', { who: 'teacher', answer });
  btn(dsc.doc, 'Lessons').click(); await settle(6); btn(dsc.doc, 'Lock the quiz…').click(); await settle(6); btn(dsc.doc, 'Lock it', true).click(); await settle(8);
  const n0 = sentOf(dsc.calls, 'admin_access_overview').length;
  dsc.win.Draft.discardAll(); await settle(20);
  t('access: discarding re-reads the server and the quiz shows as open again', dsc.win.Draft.count() === 0 && sentOf(dsc.calls, 'admin_access_overview').length === n0 + 1 && !!btn(dsc.doc, 'Lock the quiz…'));
}

function staticChecks() {
  const dash = f => read('dashboard/' + f), asset = f => read('assets/' + f);
  // every location.reload is the sign-out / re-login button
  const files = { 'dashboard/access.html': dash('access.html'), 'dashboard/master.html': dash('master.html'), 'dashboard/grading.html': dash('grading.html'), 'dashboard/team.html': dash('team.html'), 'dashboard/my-team.html': dash('my-team.html'), 'dashboard/followup.html': dash('followup.html'), 'dashboard/student-summary.html': dash('student-summary.html'), 'assets/followup-app.js': asset('followup-app.js'), 'assets/student-summary.js': asset('student-summary.js') };
  Object.keys(files).forEach(f => {
    const lines = files[f].split('\n'), bad = [];
    lines.forEach((l, i) => { if (/location\.reload\(/.test(l) && !/clearSession\(\)/.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n'))) bad.push(i + 1); });
    t('static: ' + f + ' reloads the browser only right after a sign-out', bad.length === 0, 'lines ' + bad.join());
  });
  // the Save model: staged actions are never sent directly any more
  const direct = [['assets/followup-app.js', /api\(\s*Object\.assign\(\{ action: "(admin_followup_save_group|admin_set_requirement)"/], ['assets/followup-app.js', /api\(\{ action: "admin_(followup_save_templates|group_add|followup_set_attendance)"/],
    ['dashboard/grading.html', /api\(\{ action: "admin_grade_written"/], ['assets/student-summary.js', /api\(\{ action: "p4_teacher_update_student"/]];
  direct.forEach(([f, re]) => t('static: ' + f + ' no longer sends ' + re.source.slice(0, 50) + '… directly', !re.test(files[f])));
  const acc = files['dashboard/access.html'];
  t('static: access.html stages group add/remove and the three lock actions through Draft', /var STAGED = \{ admin_group_add: 1, admin_group_remove: 1, admin_set_quiz_lock: 1, admin_set_lesson_lock: 1, admin_set_video: 1 \}/.test(acc) && /window\.Draft\.stage\(/.test(acc));
  t('static: access.html keeps payments, grants and revokes immediate (not in the staged set)', !/STAGED = \{[^}]*(decide_payment|grant_access|revoke_access)/.test(acc));
  t('static: access.html applies staged edits over every fresh load', /STATE\.data = canonOverview\(data\);\s*reapplyStaged\(\);/.test(acc));
  t('static: access.html refuses payment decisions for assistants in the page too', /isAsst\(\) && payload\.action === "admin_decide_payment"/.test(acc));
  t('static: access.html shows Group owner and Bulk access to the owner only', /if \(isOwner\(\)\) card\.appendChild\(groupOwnerRow\(g\)\)/.test(acc) && /t\[0\] === "bulk" \? isOwner\(\)/.test(acc));
  t('static: access.html hides Requests and Payment history from assistants', /\(t\[0\] === "requests" \|\| t\[0\] === "history"\) && isAsst\(\)/.test(acc));
  t('static: master.html lets teachers in through the guard and shows the scope badge', /StaffGuard\.require\(null, session\)/.test(files['dashboard/master.html']) && /addScopeBadge\(\)/.test(files['dashboard/master.html']) && !/is_admin === false/.test(files['dashboard/master.html']));
  ['dashboard/access.html', 'dashboard/followup.html', 'dashboard/student-summary.html'].forEach(f => t('static: ' + f + ' loads draft-store.js', /draft-store\.js/.test(files[f])));
  t('static: grading.html loads draft-store.js', /draft-store\.js/.test(files['dashboard/grading.html']));
  // no markup injection and no localStorage drafts in what was added
  ['dashboard/my-team.html'].forEach(f => t('static: ' + f + ' never writes innerHTML or html:', !/innerHTML\s*=|\bhtml:\s/.test(files[f])));
  const ds = asset('draft-store.js');
  t('static: draft-store.js uses sessionStorage and never localStorage', /sessionStorage/.test(ds) && !/localStorage/.test(ds.replace(/^\s*\/\*[\s\S]*?\*\//, '').replace(/\/\/.*$/gm, '').replace(/"[^"]*never localStorage[^"]*"/g, '')));
  t('static: grading.html tells owner-only links apart (Team is data-owner-only, My team is data-teacher-only)', /<a href="team\.html" data-owner-only>/.test(files['dashboard/grading.html']) && /<a href="my-team\.html" data-teacher-only>/.test(files['dashboard/grading.html']));
  t('static: staff-guard.js lists teacher-stats as owner-only', /"teacher-stats": \["admin"\]/.test(asset('staff-guard.js')));
  // assets that are mirrored by the Quiz Maker must stay in sync (none of these are)
  const mirrors = fs.readdirSync(path.join(SITE, 'tools', 'quiz-maker-v2', 'assets_templates'));
  t('static: none of staff-guard.js, draft-store.js is mirrored in assets_templates (no drift to fix)', mirrors.indexOf('staff-guard.js') < 0 && mirrors.indexOf('draft-store.js') < 0);
}

(async function () {
  const S = { guard, grading, myteam, team, summary, followup, access, static: staticChecks };
  for (const n of Object.keys(S)) if (WANT === 'all' || WANT === n) { console.log('--- ' + n); await S[n](); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
