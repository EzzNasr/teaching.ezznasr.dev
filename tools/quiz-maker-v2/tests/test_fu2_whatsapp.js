// FollowupWhatsApp.gs: the WhatsApp outbox (docs/whatsapp/README.md), through the REAL doPost (permission gate + router).
//  - off by default; owner-only page actions; the phone's own token (never the admin token) for claim / report / heartbeat
//  - enqueue validation + idempotency (same student + same items; already in the contact log)
//  - claim hands each item out once, respects mode, sending hours and the daily cap; test mode reroutes to WA_TEST_TO
//  - report: live success writes the contact log, test success does not; retryable failures go back to the queue (max 3)
//  - watchdog: an unreported item becomes "unknown" (never re-sent) + Telegram; a silent phone with work waiting -> one alert a day
// Usage: node tests/test_fu2_whatsapp.js [apps_script dir]
const path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const j = x => JSON.stringify(x);

function fresh(props) {
  const env = load([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs'), path.join(dir, 'FollowupWhatsApp.gs')],
    { clock: true, props: Object.assign({ FF_PARENT_LOG: '1', TELEGRAM_BOT_TOKEN: 'BOT', TELEGRAM_ADMIN_CHAT_ID: '111' }, props || {}) });
  env.tg = [];
  env.ctx.UrlFetchApp = { fetch(url, opts) { try { env.tg.push(JSON.parse(opts.payload).text); } catch (e) { env.tg.push(String(opts && opts.payload)); } return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' }; } };
  const triggers = [];
  env.ctx.ScriptApp = { getProjectTriggers: () => triggers.slice(), deleteTrigger: x => triggers.splice(triggers.indexOf(x), 1),
    newTrigger: fn => { const o = { fn, getHandlerFunction: () => fn, timeBased() { return o; }, everyHours() { return o; }, create() { triggers.push(o); return o; } }; return o; } };
  env.triggers = triggers;
  env.setNow('2026-11-07T12:00:00+02:00');   // Saturday noon, Alex time: inside the default 9-21 hours
  env.ctx.fu2_wa_setup();
  env.WT = env.props.WA_SENDER_TOKEN;
  env.admin = o => env.post(Object.assign({ token: 'tok' }, o));
  env.phone = o => env.post(Object.assign({ wa_token: env.WT }, o));
  env.outbox = () => env.ctx.fu2_wa_rows_(env.getSS('DATA').getSheetByName('WaOutbox'));
  env.notifs = () => { const sh = env.getSS('STU').getSheetByName('ParentNotifications'); return sh ? env.ctx._p2fuNotifications(env.getSS('STU')) : []; };
  return env;
}
const L1 = 'programming/grade-2/chapter-2-lesson-1-loops', L2 = 'programming/grade-2/chapter-2-lesson-2-functions';
const item = (n, o) => Object.assign({ student_key: '010000000' + n, student_phone: '010000000' + n, name: 'Student ' + n, to: '2011000000' + n,
  text: 'السلام عليكم ' + n, log_items: [{ kind: 'homework', ref: L1 }] }, o || {});
const enqueue = (env, items, o) => env.admin(Object.assign({ action: 'admin_fu2_wa_enqueue', group: 'Sat 18:00', group_key: 'sat-1800', event: 'parents_hw', items }, o || {}));

// ============ 1. off by default, auth ============
{
  const env = fresh();
  t('setup leaves the mode OFF and makes a 64-char phone token', env.props.WA_MODE === 'off' && /^[0-9a-f]{64}$/.test(env.WT), env.props.WA_MODE + ' ' + env.WT);
  const st = env.admin({ action: 'admin_fu2_wa_status' });
  t('status: mode off, configured, nothing queued', st.ok && st.mode === 'off' && st.configured === true && st.sent_today === 0, j(st));
  t('enqueue while off is refused', /switched off/.test(enqueue(env, [item(1)]).error || ''));
  t('status without the admin token is refused', env.post({ action: 'admin_fu2_wa_status' }).ok === false);
  t('enqueue with the PHONE token is refused (page actions need the owner)', env.post({ action: 'admin_fu2_wa_enqueue', wa_token: env.WT, event: 'parents_hw', items: [item(1)] }).ok === false);
  t('claim with the ADMIN token is refused (the phone has its own token)', /Unauthorized/.test(env.post({ action: 'admin_fu2_wa_claim', token: 'tok' }).error || ''));
  t('claim with a wrong token is refused', /Unauthorized/.test(env.post({ action: 'admin_fu2_wa_claim', wa_token: 'x'.repeat(64) }).error || ''));
  const c = env.phone({ action: 'admin_fu2_wa_claim' });
  t('claim while off: nothing, told to wait', c.ok && c.mode === 'off' && c.items.length === 0 && c.wait_sec >= 300, j(c));
  const again = env.ctx.fu2_wa_setup();
  t('running setup again keeps the same token', env.props.WA_SENDER_TOKEN === env.WT && again.ok);
}

// ============ 2. live: enqueue -> claim -> report -> contact log ============
{
  const env = fresh({ WA_MODE: 'live' });
  const e1 = enqueue(env, [item(1), item(2, { log_items: [{ kind: 'homework', ref: L1 }, { kind: 'quiz', ref: L1 }] }), item(3, { to: '01100000003' }), item(4, { text: '' }), item(5, { log_items: [] })]);
  t('enqueue: 2 queued, 3 skipped with reasons (local number, empty text, nothing to log)', e1.ok && e1.queued === 2 && e1.skipped.length === 3 &&
    /international/.test(e1.skipped[0].reason) && /empty/.test(e1.skipped[1].reason) && /nothing to log/.test(e1.skipped[2].reason), j(e1));
  t('the same tap again queues nothing (already queued)', enqueue(env, [item(1), item(2, { log_items: [{ kind: 'quiz', ref: L1 }, { kind: 'homework', ref: L1 }] })]).queued === 0);
  const rows = env.outbox();
  t('outbox rows: queued, live, text kept, phone digits as text', rows.length === 2 && rows.every(r => r.status === 'queued' && r.mode === 'live') && rows[0].to === '20110000001' && rows[0].text === 'السلام عليكم 1', j(rows.map(r => [r.status, r.to])));
  const c1 = env.phone({ action: 'admin_fu2_wa_claim', max: 1 });
  t('claim max 1: one item with to + text, gap from the server', c1.items.length === 1 && c1.items[0].to === '20110000001' && c1.gap.min === 25 && c1.gap.max === 75, j(c1));
  const c2 = env.phone({ action: 'admin_fu2_wa_claim' });
  t('the next claim hands out only the other item (never the same twice)', c2.items.length === 1 && c2.items[0].id !== c1.items[0].id, j(c2));
  t('nothing left to claim', env.phone({ action: 'admin_fu2_wa_claim' }).items.length === 0);
  const r1 = env.phone({ action: 'admin_fu2_wa_report', results: [{ id: c1.items[0].id, ok: true, wa_id: 'ABC' }, { id: c2.items[0].id, ok: true }] });
  t('report: both marked sent', r1.ok && r1.updated === 2 && env.outbox().every(r => r.status === 'sent' && r.sent_at), j(r1));
  const n = env.notifs();
  t('a live success writes the contact log, one entry per item (3), noted as WhatsApp (phone)', n.length === 3 && n.every(x => /WhatsApp \(phone\)/.test(x.note)) &&
    n.some(x => x.kind === 'quiz' && x.ref === L1), j(n));
  t('a repeated report changes nothing', env.phone({ action: 'admin_fu2_wa_report', results: [{ id: c1.items[0].id, ok: true }] }).updated === 0 && env.notifs().length === 3);
  t('enqueue of an already-contacted student is skipped', /already/.test((enqueue(env, [item(1)]).skipped[0] || {}).reason || ''));
  const st = env.admin({ action: 'admin_fu2_wa_status' });
  t('status: 2 sent today, phone last seen', st.sent_today === 2 && st.phone && st.phone.what === 'report' && st.recent.length === 2 && !('text' in st.recent[0]), j(st));
}

// ============ 3. test mode ============
{
  const env = fresh({ WA_MODE: 'test' });
  t('test mode without WA_TEST_TO refuses to queue', /WA_TEST_TO/.test(enqueue(env, [item(1)]).error || ''));
  env.props.WA_TEST_TO = '201099999999';
  t('test mode queues', enqueue(env, [item(1)]).queued === 1);
  const c = env.phone({ action: 'admin_fu2_wa_claim' });
  t('test mode: the message goes to WA_TEST_TO with a [TEST] header naming the real recipient', c.items[0].to === '201099999999' && /^\[TEST\] → Student 1 · 20110000001\n\nالسلام عليكم 1$/.test(c.items[0].text), j(c.items[0]));
  env.phone({ action: 'admin_fu2_wa_report', results: [{ id: c.items[0].id, ok: true }] });
  t('a test success is NOT written to the contact log', env.notifs().length === 0 && env.outbox()[0].status === 'sent');
  env.props.WA_MODE = 'live';
  t('test items are never handed out in live mode, and a live enqueue of the same student is allowed', enqueue(env, [item(1)]).queued === 1 && env.phone({ action: 'admin_fu2_wa_claim' }).items.every(i => i.to === '20110000001'));
}

// ============ 4. failures, retries, cap, hours, cancel ============
{
  const env = fresh({ WA_MODE: 'live', WA_DAILY_CAP: '3' });
  enqueue(env, [item(1), item(2), item(3), item(4), item(5)]);
  const c = env.phone({ action: 'admin_fu2_wa_claim' });
  t('daily cap 3: a claim hands out at most 3', c.items.length === 3, c.items.length);
  env.phone({ action: 'admin_fu2_wa_report', results: [{ id: c.items[0].id, ok: false, error: 'timeout', retryable: true }, { id: c.items[1].id, ok: false, error: 'not on WhatsApp' }, { id: c.items[2].id, ok: true }] });
  const byId = Object.fromEntries(env.outbox().map(r => [r.id, r]));
  t('retryable failure back to the queue, final failure "failed", success "sent"', byId[c.items[0].id].status === 'queued' && byId[c.items[1].id].status === 'failed' && byId[c.items[2].id].status === 'sent');
  t('a final failure is reported on Telegram with the student and the reason', env.tg.some(x => /not sent/.test(x) && /Student 2/.test(x) && /not on WhatsApp/.test(x)), j(env.tg));
  const c2 = env.phone({ action: 'admin_fu2_wa_claim' });
  t('cap counts today\'s sent: 1 sent -> 2 more', c2.items.length === 2, c2.items.length);
  env.phone({ action: 'admin_fu2_wa_report', results: c2.items.map(i => ({ id: i.id, ok: false, error: 'x', retryable: true })) });
  // the retried one is on attempt 2; make it fail retryably twice more -> failed after 3 attempts
  for (let k = 0; k < 2; k++) { const cc = env.phone({ action: 'admin_fu2_wa_claim' }); env.phone({ action: 'admin_fu2_wa_report', results: cc.items.map(i => ({ id: i.id, ok: false, error: 'x', retryable: true })) }); }
  t('after 3 attempts a retryable failure stops (failed)', env.outbox().find(r => r.id === c.items[0].id).status === 'failed', j(env.outbox().map(r => [r.status, r.attempts])));
  env.setNow('2026-11-07T22:30:00+02:00');
  const night = env.phone({ action: 'admin_fu2_wa_claim' });
  t('22:30 Alex: outside sending hours, nothing handed out', night.items.length === 0 && /outside sending hours/.test(night.why), j(night));
  env.setNow('2026-11-08T10:00:00+02:00');
  const cc = env.admin({ action: 'admin_fu2_wa_cancel', all: true });
  t('cancel all: every queued item is cancelled, nothing left to claim', cc.ok && cc.cancelled >= 1 && env.phone({ action: 'admin_fu2_wa_claim' }).items.length === 0, j(cc));
}

// ============ 5. watchdog: unreported items, silent phone, logged out ============
{
  const env = fresh({ WA_MODE: 'live' });
  enqueue(env, [item(1), item(2)]);
  const c = env.phone({ action: 'admin_fu2_wa_claim', max: 1 });
  env.setNow('2026-11-07T12:20:00+02:00');   // lease 15 min passed, no report
  const w = env.ctx.fu2_wa_watchdog();
  const r = env.outbox().find(x => x.id === c.items[0].id);
  t('an item handed out and never reported becomes "unknown" (not re-queued)', w.stuck === 1 && r.status === 'unknown', j(w) + r.status);
  t('...and Telegram says to check the chat before sending again', env.tg.some(x => /no report/.test(x) && /Student 1/.test(x)));
  t('an unknown item is not handed out again', env.phone({ action: 'admin_fu2_wa_claim' }).items.every(i => i.id !== c.items[0].id));
  t('a late success report still completes it (and logs it)', env.phone({ action: 'admin_fu2_wa_report', results: [{ id: c.items[0].id, ok: true }] }).updated === 1 && env.notifs().length === 1);
  enqueue(env, [item(3)]);
  env.props.WA_LAST_SEEN = JSON.stringify({ at: 'x', ms: Date.now() - 3 * 3600000, state: 'connected' });
  const before = env.tg.length; env.ctx.fu2_wa_watchdog(); env.ctx.fu2_wa_watchdog();
  t('queued work + phone silent 3 h: ONE "phone is silent" alert per day', env.tg.length === before + 1 && /silent/.test(env.tg[env.tg.length - 1]), j(env.tg.slice(before)));
  const hb = env.phone({ action: 'admin_fu2_wa_heartbeat', state: 'logged_out' }); env.phone({ action: 'admin_fu2_wa_heartbeat', state: 'logged_out' });
  t('logged out: one Telegram alert, not repeated', hb.ok && env.tg.filter(x => /logged out/.test(x)).length === 1);
  t('install / remove the hourly trigger', env.ctx.fu2_wa_installTrigger() && env.triggers.length === 1 && (env.ctx.fu2_wa_removeTrigger(), env.triggers.length === 0));
  t('the mode switch functions', env.ctx.fu2_wa_modeOff() === 'off' && env.props.WA_MODE === 'off' && env.ctx.fu2_wa_modeTest() === 'test' && env.ctx.fu2_wa_modeLive() === 'live');
}

// ============ 6. the rest of the site is untouched ============
{
  const env = fresh();
  const unknown = env.post({ action: 'admin_fu2_nope', token: 'tok' });
  t('an unknown admin_fu2_ action still answers Unknown action', /Unknown action/.test(unknown.error || ''), j(unknown));
  t('the follow-up router still has its other routes', typeof env.ctx.fu2_routes_().admin_fu2_group_duplicates === 'function' && typeof env.ctx.fu2_routes_().admin_fu2_wa_claim === 'function');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
