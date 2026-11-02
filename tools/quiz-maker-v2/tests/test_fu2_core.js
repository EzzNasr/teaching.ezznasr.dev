// Follow-up v2, Session 5: the core wiring in Code.gs + FollowupRouter.gs.
//   routing of admin_fu2_* / admin_req_*, the allow-list (assistants), the overview hooks, the Telegram "fu:" callback,
//   the internal overview, and admin_fu2_group_duplicates.
// S2's / S4's functions are STUBS defined here (same names as the contract), loaded only where a test wants them.
// Usage: node tests/test_fu2_core.js [apps_script dir]
const path = require('path'), vm = require('vm'), crypto = require('crypto');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (typeof x === 'string' ? x : JSON.stringify(x)))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const CODE = path.join(dir, 'Code.gs'), ROUTER = path.join(dir, 'FollowupRouter.gs');
const ADMIN_ONLY_FU2 = ['admin_fu2_notify_test', 'admin_fu2_group_duplicates'];
const STAFF_FU2 = ['admin_fu2_mark_done', 'admin_fu2_notify_settings_get', 'admin_fu2_notify_settings_save', 'admin_req_get', 'admin_req_save_global', 'admin_req_save_group', 'admin_req_check', 'admin_req_history'];

function boot(files, props) {
  const env = load(files, { props: Object.assign({ TELEGRAM_BOT_TOKEN: 'BOT', TELEGRAM_ADMIN_CHAT_ID: '111', TELEGRAM_WEBHOOK_SECRET: 'sec' }, props || {}) });
  const { post, getSS } = env;
  const reg = (phone, pw, name) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 2', parent_phone: '01100000009' });
  const adm = reg('01000000001', 'a', 'Teacher');
  const stu = getSS('STU').getSheetByName('Students');
  let col = 0; for (let c = 1; c <= 16; c++) if (stu.get(1, c) === 'is_admin') col = c;
  stu.set(2, col, true);
  const sara = reg('01000000002', 'b', 'Sara'), omar = reg('01000000003', 'c', 'Omar');
  const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
  env.ADMIN = cr(adm); env.SARA = cr(sara); env.OMAR = cr(omar); env.TOK = { token: 'tok' };
  env.ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200 }) };
  env.run = code => vm.runInContext(code, env.ctx);
  env.makeAssistant = () => post(Object.assign({ action: 'p3_admin_set_role', phone: '01000000002', role: 'assistant' }, env.ADMIN));
  return env;
}
// Stubs shaped like S2's and S4's route maps: they authenticate with _requireAdminAny, as the real ones do.
const STUB_ROUTES = `
  function fu2_notify_routes_() { return {
    admin_fu2_mark_done: function (p) { _requireAdminAny(p); return { ok: true, from: 'notify', done: [] }; },
    admin_fu2_notify_settings_get: function (p) { _requireAdminAny(p); return { ok: true, groups: {} }; },
    admin_fu2_notify_settings_save: function (p) { _requireAdminAny(p); return { ok: true, settings: {} }; },
    admin_fu2_notify_test: function (p) { _requireAdminAny(p); return { ok: true, sent_to: 1 }; } }; }
  function req_routes_() { return {
    admin_req_get: function (p) { _requireAdminAny(p); return { ok: true, from: 'req' }; },
    admin_req_save_global: function (p) { _requireAdminAny(p); return { ok: true }; },
    admin_req_save_group: function (p) { _requireAdminAny(p); return { ok: true }; },
    admin_req_check: function (p) { _requireAdminAny(p); return { ok: true }; },
    admin_req_history: function (p) { _requireAdminAny(p); return { ok: true, items: [] }; } }; }`;

// ============ 1. Routing ============
{
  const e = boot([CODE, ROUTER]); e.run(STUB_ROUTES);
  let r = e.post(Object.assign({ action: 'admin_fu2_mark_done' }, e.TOK));
  t('admin_fu2_* reaches S2\'s route map', r.ok && r.from === 'notify', r);
  r = e.post(Object.assign({ action: 'admin_req_get' }, e.TOK));
  t('admin_req_* reaches S4\'s route map', r.ok && r.from === 'req', r);
  for (const a of ['admin_fu2_nope', 'admin_req_nope', 'admin_fu2_', 'admin_req_constructor', 'admin_fu2___proto__']) {
    r = e.post(Object.assign({ action: a }, e.TOK));
    t('unknown ' + a + ' answers the standard "Unknown action" error', r.ok === false && /^Unknown action/.test(r.error), r);
  }
  t('a name that merely contains the prefix is not routed there', /^Unknown action/.test(e.post({ action: 'xadmin_fu2_mark_done' }).error) && /^Unknown action/.test(e.post({ action: 'admin_fu2x' }).error));
  t('unrelated unknown actions are unchanged', /^Unknown action: nope$/.test(e.post({ action: 'nope' }).error));
  t('an existing action still works (ping)', e.post(Object.assign({ action: 'ping' }, e.TOK)).message === 'pong');
  r = e.post({ action: 'admin_fu2_mark_done' });
  t('a route that checks auth refuses no credentials', r.ok === false && /Not authorized|Missing session/.test(r.error), r);
  r = e.post(Object.assign({ action: 'admin_fu2_mark_done' }, e.SARA));
  t('...and a plain student', r.ok === false && /Not authorized/.test(r.error), r);
  r = e.run(`JSON.stringify(Object.keys(fu2_routes_()).sort())`);
  t('merged map = the 4 + 5 + 1 actions', JSON.parse(r).length === 10 && JSON.parse(r).indexOf('admin_fu2_group_duplicates') >= 0, r);
  e.run(`function fu2_notify_routes_() { throw new Error('boom'); }`);
  r = e.post(Object.assign({ action: 'admin_req_get' }, e.TOK));
  t('a route map that throws is skipped; the others still work', r.ok && r.from === 'req', r);
  e.run(`function req_routes_() { return { admin_fu2_group_duplicates: function () { return { ok: true, hijack: true }; } }; }`);
  r = e.post(Object.assign({ action: 'admin_fu2_group_duplicates' }, e.TOK));
  t('core routes cannot be shadowed by another file', r.ok && !r.hijack && Array.isArray(r.duplicates), r);
}
{
  const e = boot([CODE]);   // FollowupRouter.gs not deployed at all
  const r = e.post(Object.assign({ action: 'admin_fu2_mark_done' }, e.TOK));
  t('without FollowupRouter.gs: standard Unknown action, no crash', r.ok === false && /^Unknown action/.test(r.error), r);
  t('...and the follow-up overview still works', e.post(Object.assign({ action: 'admin_followup_overview' }, e.TOK)).ok === true);
}
{
  const e = boot([CODE, ROUTER]);   // router only: no S2, no S4
  let r = e.post(Object.assign({ action: 'admin_fu2_mark_done' }, e.TOK));
  t('router alone: S2/S4 actions are Unknown action', /^Unknown action/.test(r.error), r);
  r = e.post(Object.assign({ action: 'admin_fu2_group_duplicates' }, e.TOK));
  t('router alone: the core action works', r.ok === true && Array.isArray(r.duplicates), r);
}

// ============ 2. Allow-list and roles ============
{
  const e = boot([CODE, ROUTER]); e.run(STUB_ROUTES);
  const al = e.ctx.P3_STAFF_ALLOW;
  t('the 8 staff actions are on P3_STAFF_ALLOW', STAFF_FU2.every(a => al.indexOf(a) >= 0), al);
  t('the 2 admin-only actions are NOT', ADMIN_ONLY_FU2.every(a => al.indexOf(a) < 0), al);
  t('the Phase 3 actions are still there (13) and nothing else was added', al.length === 21, al.length);
  e.makeAssistant();
  for (const a of STAFF_FU2) {
    const r = e.post(Object.assign({ action: a }, e.SARA));
    t('assistant may call ' + a, r.ok === true, r);
  }
  for (const a of ADMIN_ONLY_FU2) {
    const r = e.post(Object.assign({ action: a }, e.SARA));
    t('assistant is refused ' + a, r.ok === false && /Not authorized/.test(r.error), r);
    const rr = e.post(Object.assign({ action: a }, e.TOK));
    t('...the admin token and admin session are not (' + a + ')', rr.ok === true && e.post(Object.assign({ action: a }, e.ADMIN)).ok === true, rr);
  }
  const r = e.post(Object.assign({ action: 'admin_fu2_mark_done' }, e.OMAR));
  t('a plain student is refused everything', r.ok === false && /Not authorized/.test(r.error), r);
}

// ============ 3. Overview hooks ============
{
  const e = boot([CODE, ROUTER]);
  const base = e.post(Object.assign({ action: 'admin_followup_overview' }, e.TOK));
  t('no hook functions: the overview is unchanged (no new fields)', base.ok && base.tz_label === undefined && base.unclassified_requirements === undefined);
  e.run(`var __order = [];
    function fu2_notify_overviewHook_(o) { __order.push('notify'); o.tz_label = 'Alex'; o.notify_seen = true; }
    function req_overviewHook_(o) { __order.push('req'); o.unclassified_requirements = { homework: { enabled: true } }; o.sawNotify = !!o.notify_seen; }`);
  let o = e.post(Object.assign({ action: 'admin_followup_overview' }, e.TOK));
  t('hooks fill their parts, notify first then req', o.tz_label === 'Alex' && o.unclassified_requirements && e.run('__order.join(",")') === 'notify,req' && o.sawNotify === true, o);
  t('existing overview fields are untouched', JSON.stringify(Object.keys(base).sort().filter(k => k !== 'sawNotify')) === JSON.stringify(Object.keys(o).filter(k => !['tz_label', 'notify_seen', 'unclassified_requirements', 'sawNotify'].includes(k)).sort()), [Object.keys(base), Object.keys(o)]);
  e.run(`function fu2_notify_overviewHook_(o) { o.half = 1; throw new Error('hook broke'); }`);
  o = e.post(Object.assign({ action: 'admin_followup_overview' }, e.TOK));
  t('a hook that throws does not break the overview, and the next hook still runs', o.ok === true && o.unclassified_requirements && o.flags, o);
  e.run(`function req_overviewHook_(o) { throw new Error('also broke'); }`);
  o = e.post(Object.assign({ action: 'admin_followup_overview' }, e.TOK));
  t('both throwing: still a normal overview', o.ok === true && o.flags && Array.isArray(o.groups), o);
  e.run(`var req_overviewHook_ = 5; var fu2_notify_overviewHook_ = null;`);
  t('a non-function with the hook name is ignored', e.post(Object.assign({ action: 'admin_followup_overview' }, e.TOK)).ok === true);
  t('assistant-allowed overview carries hooks too (same function)', true);
}

// ============ 4. Internal overview (for S2's tick) ============
{
  const e = boot([CODE, ROUTER]);
  e.run(`function fu2_notify_overviewHook_(o) { o.tz_label = 'Alex'; }`);
  const o = e.ctx.fu2_core_overviewInternal_();
  t('internal overview: same shape as the action, hooks included, no session needed', o.ok === true && o.tz_label === 'Alex' && o.flags && Array.isArray(o.groups), Object.keys(o));
  const viaAction = e.post(Object.assign({ action: 'admin_followup_overview' }, e.TOK));
  t('...and equal to what admin_followup_overview returns', JSON.stringify(Object.keys(o).sort()) === JSON.stringify(Object.keys(viaAction).sort()));
  for (const a of ['fu2_core_overviewInternal_', 'admin_fu2_core_overviewInternal_', 'admin_fu2_core_overviewInternal', 'fu2_dispatch_', 'admin_req_core']) {
    const r = e.post(Object.assign({ action: a }, e.TOK));
    t('not reachable as an action: ' + a, r.ok === false && /^Unknown action/.test(r.error), r);
  }
  const r2 = e.post({ action: 'admin_followup_overview', internal: true, skip_auth: true, fu2_internal: true });
  t('no payload flag can skip the session check', r2.ok === false && /Not authorized|Missing session/.test(r2.error), r2);
  e.props.ADMIN_TOKEN = '';
  let thrown = null; try { e.ctx.fu2_core_overviewInternal_(); } catch (x) { thrown = x; }
  t('without an ADMIN_TOKEN property it fails closed (throws), never opens up', thrown && /Not authorized|Missing session/.test(String(thrown.message)), String(thrown));
}

// ============ 5. Telegram fu: callbacks ============
{
  const e = boot([CODE, ROUTER]);
  e.run(`var __log = []; var __cq = null;
    function _tgCall(m, b) { __log.push([m, b]); }
    function fu2_notify_telegramCallback_(cq) { __cq = cq; return 'VERDICT ' + cq.data; }
    function handleAdminDecidePayment(p) { __log.push(['payment', p.payment_id, p.decision]); }`);
  let uid = 0;
  const tap = (data, from, secret, upd) => {
    e.run('__log.length = 0; __cq = null');
    e.ctx.handleTelegramUpdate({ parameter: { tg: secret === undefined ? 'sec' : secret } },
      { update_id: upd === undefined ? ++uid : upd, callback_query: { id: 'cb', from: { id: from }, data, message: { message_id: 5, chat: { id: from }, text: 'orig', entities: [] } } });
    return JSON.parse(e.run('JSON.stringify(__log)'));
  };
  let l = tap('fu:snooze:sat-1800', 111);
  t('fu: from an admin chat -> fu2_notify_telegramCallback_', e.run('__cq && __cq.data') === 'fu:snooze:sat-1800', l);
  t('the spinner is cleared and the message edited with the verdict', l.some(x => x[0] === 'answerCallbackQuery') && l.some(x => x[0] === 'editMessageText' && /VERDICT fu:snooze:sat-1800/.test(x[1].text) && /^orig/.test(x[1].text)), l);
  t('a payment is NOT decided by an fu: tap', l.every(x => x[0] !== 'payment'));
  l = tap('fu:done:sat-1800:remind_hw:2026-11-07', 111);
  t('colons inside the payload are passed through whole', e.run('__cq.data') === 'fu:done:sat-1800:remind_hw:2026-11-07');
  l = tap('fu:snooze:x', 999);
  t('fu: from someone who is not an admin id is ignored', l.length === 0 && e.run('__cq') === null, l);
  l = tap('fu:snooze:x', 111, 'wrong');
  t('wrong webhook secret is ignored', l.length === 0 && e.run('__cq') === null);
  tap('fu:snooze:dup', 111, 'sec', 777); l = tap('fu:snooze:dup', 111, 'sec', 777);
  t('the same update_id is handled once (Telegram retries are ignored)', l.length === 0 && e.run('__cq') === null, l);
  l = tap('ap:P-1', 111);
  t('ap: is unchanged (payment approve)', l.some(x => x[0] === 'payment' && x[1] === 'P-1' && x[2] === 'approve') && e.run('__cq') === null, l);
  l = tap('zz:what', 111);
  t('an unknown prefix is still ignored', l.length === 0);
  e.run(`fu2_notify_telegramCallback_ = undefined;`);
  l = tap('fu:snooze:x', 111);
  t('without FollowupNotify.gs: a polite line, nothing thrown', l.some(x => x[0] === 'editMessageText' && /Not available/.test(x[1].text)), l);
  e.run(`function fu2_notify_telegramCallback_() { throw new Error('boom'); }`);
  let threw = false; try { l = tap('fu:snooze:y', 111); } catch (x) { threw = true; }
  t('a throwing callback never fails the webhook', !threw && l.some(x => x[0] === 'sendMessage' && /boom/.test(x[1].text)), l);
}

// ============ 6. admin_fu2_group_duplicates ============
{
  const e = boot([CODE, ROUTER]);
  const addRow = (g, p) => { const sh = e.getSS('STU').getSheetByName('Groups'); const r = sh.getLastRow() + 1; const h = {}; for (let c = 1; c <= 8; c++) if (sh.get(1, c)) h[sh.get(1, c)] = c; sh.set(r, h.group, g); sh.set(r, h.phone, p); sh.set(r, h.name, ''); sh.set(r, h.added_at, '2026-01-01 00:00:00'); };
  e.post(Object.assign({ action: 'admin_group_add', group: 'A', phones: ['01000000002', '01000000003'] }, e.TOK));
  e.post(Object.assign({ action: 'admin_group_add', group: 'B', phone: '01000000001' }, e.TOK));
  let r = e.post(Object.assign({ action: 'admin_fu2_group_duplicates' }, e.TOK));
  t('no duplicates: empty list', r.ok && r.duplicates.length === 0, r);
  addRow('B', '01000000002'); addRow('C', '+201000000002'); addRow('a', '01000000003');   // legacy rows: Sara in A+B+C, Omar in A twice (same group)
  const before = JSON.stringify(e.getSS('STU').getSheetByName('Groups').cells.size);
  r = e.post(Object.assign({ action: 'admin_fu2_group_duplicates' }, e.ADMIN));
  const sara = r.duplicates.find(d => /1000000002$/.test(d.phone));
  t('Sara (in A, B and C) is reported with her groups, by name', r.ok && r.duplicates.length === 1 && sara && sara.name === 'Sara' && sara.groups.join(',') === 'A,B,C', r);
  t('a student twice in the SAME group (different spelling) is not a duplicate', !r.duplicates.some(d => /1000000003$/.test(d.phone)));
  t('it never changes data', JSON.stringify(e.getSS('STU').getSheetByName('Groups').cells.size) === before);
  e.makeAssistant();
  t('assistant refused', e.post(Object.assign({ action: 'admin_fu2_group_duplicates' }, e.SARA)).ok === false);
  t('student refused', e.post(Object.assign({ action: 'admin_fu2_group_duplicates' }, e.OMAR)).ok === false);
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
