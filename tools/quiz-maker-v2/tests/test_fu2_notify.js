// Follow-up v2, Session 2: FollowupNotify.gs (hourly tick, dedup, quiet hours, snooze/enabled, Telegram callbacks,
// the four actions, the overview hook). S3's dueNow and S5's overview builder are STUBS defined here (not shipped).
// Usage: node tests/test_fu2_notify.js [apps_script dir]
const path = require('path'), vm = require('vm');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

const FRI_EVE = '2026-11-06T16:30:00+02:00';   // golden example 1
const SAT_NIGHT = '2026-11-07T20:30:00+02:00'; // golden example 2

function fresh() {
  const env = load([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupNotify.gs')], { clock: true, props: { TELEGRAM_BOT_TOKEN: 'BOT', TELEGRAM_ADMIN_CHAT_ID: '111,222' } });
  const calls = [];
  const net = { fail: false, code: 200 };
  env.ctx.UrlFetchApp = { fetch(url, opts) {
    if (net.fail) throw new Error('network down');
    const body = JSON.parse(opts.payload);
    calls.push({ method: url.split('/').pop(), body });
    return { getResponseCode: () => net.code };
  } };
  const triggers = []; let nextId = 0;
  env.ctx.ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: tr => { const i = triggers.indexOf(tr); if (i >= 0) triggers.splice(i, 1); },
    newTrigger: fn => { const o = { fn, id: ++nextId, getHandlerFunction() { return fn; }, timeBased() { return o; }, everyHours(n) { o.hours = n; return o; }, create() { triggers.push(o); return o; } }; return o; },
  };
  env.calls = calls; env.net = net; env.triggers = triggers;
  env.sent = () => calls.filter(c => c.method === 'sendMessage');
  env.setNow(FRI_EVE);
  return env;
}
const run = (env, code) => vm.runInContext(code, env.ctx);
const j = x => JSON.stringify(x);

// ---- stubs for the other sessions (same names and shapes as the contract) ----
function stubs(env, state) {
  state.overview = state.overview || { groups: [{ key: 'sat-1800', group: 'Sat 18:00', members: [] }, { key: 'sun-1000', group: 'Sun 10:00', members: [] }] };
  state.items = state.items || [];
  env.ctx.fu2_core_overviewInternal_ = () => { const o = JSON.parse(JSON.stringify(state.overview)); if (typeof env.ctx.fu2_notify_overviewHook_ === 'function') env.ctx.fu2_notify_overviewHook_(o); state.lastOverview = o; return o; };
  // Honours groups[].notify the way the contract says dueNow must: disabled or snoozed group -> nothing.
  env.ctx.fu2_logic_dueNow_ = (ov, nowIso) => {
    const day = nowIso.slice(0, 10);
    return state.items.filter(it => {
      const g = ov.groups.find(x => x.key === it.group_key); const n = g && g.notify;
      if (n && (n.enabled === false || (n.snooze_until && day < n.snooze_until))) return false;
      return true;
    }).map(it => JSON.parse(JSON.stringify(it)));
  };
}
const item = (o) => Object.assign({ group_key: 'sat-1800', group: 'Sat 18:00', key: 'remind_hw', session_date: '2026-11-07', count: 3, student_keys: ['1012345678'], lesson: 'programming/grade-2/chapter-2-lesson-1-loops', blocked_count: 0 }, o);

// ============ 1. Dedup across ticks ============
{
  const env = fresh(), st = {}; stubs(env, st); st.items = [item({})];
  const r1 = env.ctx.fu2_notify_tick_();
  t('first tick sends once to each of the 2 chats', r1.ok && env.sent().length === 2 && j(env.sent().map(c => c.body.chat_id)) === '["111","222"]', j(r1) + j(env.calls));
  const r2 = env.ctx.fu2_notify_tick_();
  t('second tick sends nothing (dedup on group|session|event)', r2.ok && env.sent().length === 2, j(r2));
  const log = env.getSS('DATA').getSheetByName('FollowupNotifications') || env.getSS('STU').getSheetByName('FollowupNotifications');
  t('log has headers + exactly one row', log && log.getLastRow() === 2 && log.get(1, 1) === 'group_key' && log.get(2, 4) === 'remind_hw' && log.get(2, 3) === '2026-11-07', log && log.getLastRow());
  t('log row keeps the session date as text, count recorded', log.get(2, 6) === '3' || log.get(2, 6) === 3);
  st.items = [item({}), item({ session_date: '2026-11-14' })];
  env.ctx.fu2_notify_tick_();
  t('same event for a NEW session date is a new notification', env.sent().length === 4, env.sent().length);
  st.items = [item({}), item({ key: 'parents_hw' })];
  env.ctx.fu2_notify_tick_();
  t('a different event for the same session is a new notification', env.sent().length === 6, env.sent().length);
}

// ============ 2. Quiet hours ============
{
  const env = fresh(), st = {}; stubs(env, st); st.items = [item({})];
  env.setNow('2026-11-06T23:00:00+02:00');
  let r = env.ctx.fu2_notify_tick_();
  t('23:00 Alex: deferred, nothing sent, nothing logged', r.ok && r.quiet && env.sent().length === 0 && !env.getSS('DATA').getSheetByName('FollowupNotifications'), j(r));
  env.setNow('2026-11-07T07:59:00+02:00'); env.ctx.fu2_notify_tick_();
  t('07:59 Alex: still quiet', env.sent().length === 0);
  env.setNow('2026-11-07T08:00:00+02:00'); env.ctx.fu2_notify_tick_();
  t('08:00 Alex: the deferred event goes out', env.sent().length === 2, env.sent().length);
  env.setNow('2026-11-07T21:59:00+02:00'); st.items = [item({ key: 'parents_hw' })]; env.ctx.fu2_notify_tick_();
  t('21:59 Alex: still inside the window', env.sent().length === 4);
  env.setNow('2026-11-07T22:00:00+02:00'); st.items = [item({ key: 'attendance' })]; env.ctx.fu2_notify_tick_();
  t('22:00 Alex: quiet again', env.sent().length === 4);
  // Summer time: 22:30 Alex local is 19:30 UTC; the check must use Alex local time, not UTC.
  env.setNow('2026-07-10T09:00:00+03:00'); st.items = [item({ session_date: '2026-07-11' })]; env.ctx.fu2_notify_tick_();
  t('window follows Alex local time in summer time too (09:00 +03:00 sends)', env.sent().length === 6, env.sent().length);
}

// ============ 3. enabled:false and snooze silence a group (through settings -> hook -> engine) ============
{
  const env = fresh(), st = {}; stubs(env, st); st.items = [item({}), item({ group_key: 'sun-1000', group: 'Sun 10:00' })];
  const adm = { token: 'tok' };
  let r = env.ctx.fu2_notify_routes_().admin_fu2_notify_settings_save({ ...adm, group: 'sat-1800', enabled: false });
  t('settings_save enabled:false -> ok', r.ok && r.settings.enabled === false && r.settings.hour === 16, j(r));
  env.ctx.fu2_notify_tick_();
  t('disabled group is silent, the other group still notifies', env.sent().length === 2 && env.sent().every(c => /Sun 10:00/.test(c.body.text)), j(env.sent().map(c => c.body.text)));
  t('the overview still carries the notify block for the disabled group (page can show it)', st.lastOverview.groups[0].notify.enabled === false);
  env.ctx.fu2_notify_routes_().admin_fu2_notify_settings_save({ ...adm, group: 'sat-1800', enabled: true, snooze_until: '2026-11-07' });
  const before = env.sent().length;
  st.items = [item({ key: 'parents_hw' })]; env.ctx.fu2_notify_tick_();
  t('snooze_until tomorrow silences the group today', env.sent().length === before, env.sent().length);
  env.setNow('2026-11-07T09:00:00+02:00'); env.ctx.fu2_notify_tick_();
  t('snooze ends on its date (08:00+ that day sends)', env.sent().length === before + 2, env.sent().length);
  r = env.ctx.fu2_notify_routes_().admin_fu2_notify_settings_save({ ...adm, group: 'sat-1800', snooze_until: '' });
  t('snooze can be cleared with ""', r.ok && r.settings.snooze_until === '' && r.settings.enabled === true, j(r));
}

// ============ 4. Hook output matches contract 3.4 ============
{
  const env = fresh();
  const ov = { groups: [{ key: 'sat-1800', group: 'Sat 18:00' }, { key: 'sun-1000', group: 'Sun 10:00' }] };
  env.ctx.fu2_notify_overviewHook_(ov);
  t('no sheets yet: tz_label "Alex", empty done, default notify {true,16,""}', ov.tz_label === 'Alex' && j(ov.groups[0].done) === '[]' && j(ov.groups[0].notify) === '{"enabled":true,"hour":16,"snooze_until":""}', j(ov));
  t('the hook does not create sheets (read only)', !env.getSS('DATA').getSheetByName('FollowupDone') && !env.getSS('DATA').getSheetByName('NotifySettings'));
  const R = env.ctx.fu2_notify_routes_(), adm = { token: 'tok' };
  R.admin_fu2_mark_done({ ...adm, group: 'sat-1800', kind: 'watch', session_date: '2026-11-07' });
  R.admin_fu2_mark_done({ ...adm, group: 'sat-1800', kind: 'hw', session_date: '2026-11-07' });
  R.admin_fu2_mark_done({ ...adm, group: 'sun-1000', kind: 'advance', session_date: '2026-11-01' });
  R.admin_fu2_notify_settings_save({ ...adm, group: 'sun-1000', hour: 9, snooze_until: '2026-11-09' });
  const ov2 = { groups: [{ key: 'sat-1800' }, { key: 'sun-1000' }, { key: 'other' }] };
  env.ctx.fu2_notify_overviewHook_(ov2);
  t('done lists per group as "kind|date"', j(ov2.groups[0].done) === '["watch|2026-11-07","hw|2026-11-07"]' && j(ov2.groups[1].done) === '["advance|2026-11-01"]' && j(ov2.groups[2].done) === '[]', j(ov2.groups.map(g => g.done)));
  t('notify per group, defaults for a group with no row', j(ov2.groups[1].notify) === '{"enabled":true,"hour":9,"snooze_until":"2026-11-09"}' && j(ov2.groups[2].notify) === '{"enabled":true,"hour":16,"snooze_until":""}', j(ov2.groups.map(g => g.notify)));
  let reads = 0; const ss = env.getSS('DATA'); const orig = ss.getSheetByName.bind(ss);
  ss.getSheetByName = n => { if (n === 'FollowupDone' || n === 'NotifySettings') reads++; return orig(n); };
  env.ctx.fu2_notify_overviewHook_({ groups: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] });
  t('one read of each sheet no matter how many groups', reads === 2, reads);
  env.ctx.fu2_notify_overviewHook_({});
  env.ctx.fu2_notify_overviewHook_(null);
  t('hook tolerates an overview with no groups / null', true);
}

// ============ 5. Messages: "Alex", never "Cairo"; format; buttons ============
{
  const env = fresh(), st = {}; stubs(env, st);
  st.items = ['setup_missing', 'remind_watch', 'parents_watch', 'remind_hw', 'parents_hw', 'attendance', 'advance_lessons'].map(k => item({ key: k, blocked_count: k === 'parents_hw' ? 2 : 0 }));
  env.ctx.fu2_notify_tick_();
  env.ctx.fu2_notify_routes_().admin_fu2_notify_test({ token: 'tok' });
  const texts = env.sent().map(c => c.body.text);
  t('7 events x 2 chats + 2 test messages sent', texts.length === 16, texts.length);
  t('every message says "Alex"', texts.every(x => /\d{1,2}:\d\d (AM|PM) Alex/.test(x)), texts.filter(x => !/Alex/.test(x)).join('|'));
  // integration: 12-hour clock in Telegram (owner decision); no bare 24-hour time anywhere a person reads
  t('Telegram times are 12-hour ("4:05 PM Alex"), never 24-hour', texts.length > 0 && texts.every(x => !/\b(?:[01]?\d|2[0-3]):[0-5]\d\b(?!\s*(?:AM|PM))/.test(x.replace(/<b>[^<]*<\/b>/g, ''))), texts.join(' | ').slice(0, 300));
  t('fu2_notify_time12_: 00:05 -> 12:05 AM, 12:00 -> 12:00 PM, 16:00 -> 4:00 PM, bad -> ""', env.ctx.fu2_notify_time12_('00:05') === '12:05 AM' && env.ctx.fu2_notify_time12_('12:00') === '12:00 PM' && env.ctx.fu2_notify_time12_('16:00') === '4:00 PM' && env.ctx.fu2_notify_time12_('x') === '');
  t('no message says "Cairo"', texts.every(x => !/cairo/i.test(x)));
  const hw = env.sent().find(c => /homework, 3 missing/.test(c.body.text));
  t('remind_hw text: group in bold, count, lesson line', hw && /^\ud83d\udcdd <b>Sat 18:00<\/b>: remind the group about homework, 3 missing\./.test(hw.body.text) && /Grade 2/.test(hw.body.text), hw && hw.body.text);
  const ph = env.sent().find(c => /missing homework or the quiz/.test(c.body.text));
  t('parents_hw reports students waiting for attendance (blocked_count)', /2 more waiting for attendance first/.test(ph.body.text), ph.body.text);
  t('HTML parse mode, previews off', hw.body.parse_mode === 'HTML' && hw.body.disable_web_page_preview === true);
  const kb = hw.body.reply_markup.inline_keyboard[0];
  t('Open button is a URL with #g=<key>&step=<event>', kb[0].text === 'Open' && kb[0].url === 'https://teaching.ezznasr.dev/dashboard/followup.html#g=sat-1800&step=remind_hw', j(kb[0]));
  t('snooze callback is fu:snooze:<group_key>', kb.some(b => b.callback_data === 'fu:snooze:sat-1800'), j(kb));
  t('done callback is fu:done:<group_key>:<event>:<session_date> for markable events', kb.some(b => b.callback_data === 'fu:done:sat-1800:remind_hw:2026-11-07'), j(kb));
  const att = env.sent().find(c => /mark attendance/.test(c.body.text));
  t('attendance and parents_* have no Done button', !att.body.reply_markup.inline_keyboard[0].some(b => /^fu:done/.test(b.callback_data || '')) && !ph.body.reply_markup.inline_keyboard[0].some(b => /^fu:done/.test(b.callback_data || '')));
  t('every callback_data is <= 64 bytes', env.sent().filter(c => c.body.reply_markup).every(c => c.body.reply_markup.inline_keyboard[0].every(b => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64)));
  // Names typed by people are escaped for HTML
  const env2 = fresh(), st2 = {}; stubs(env2, st2); st2.items = [item({ group: 'A <b>&</b> B' })]; env2.ctx.fu2_notify_tick_();
  t('group names are HTML-escaped', /A &lt;b&gt;&amp;&lt;\/b&gt; B/.test(env2.sent()[0].body.text), env2.sent()[0].body.text);
  // Over-long group key: callbacks dropped, message still sent with the Open button
  const env3 = fresh(), st3 = {}; stubs(env3, st3); const longKey = 'g-' + 'x'.repeat(60); st3.overview = { groups: [{ key: longKey, group: 'L' }] }; st3.items = [item({ group_key: longKey })];
  env3.ctx.fu2_notify_tick_();
  const b3 = env3.sent()[0].body.reply_markup.inline_keyboard[0];
  t('a group key too long for callback_data: callbacks omitted, Open kept, message still sent', env3.sent().length === 2 && b3.length === 1 && b3[0].text === 'Open', j(b3));
  const long = fresh(), stl = {}; stubs(long, stl); stl.items = [item({ group: 'G'.repeat(5000), lesson: 'L'.repeat(5000) })]; long.ctx.fu2_notify_tick_();
  t('text is capped under 3500 chars', long.sent().length === 2 && long.sent()[0].body.text.length <= 3500, long.sent()[0] && long.sent()[0].body.text.length);
}

// ============ 6. Silence, bad input and missing pieces ============
{
  const env = fresh(), st = {}; stubs(env, st); st.items = [item({ count: 0 })];
  env.ctx.fu2_notify_tick_();
  t('count 0 is silent', env.sent().length === 0);
  const env2 = fresh();
  let r; try { r = env2.ctx.fu2_notify_tick_(); } catch (e) { r = { threw: String(e) }; }
  t('without S3/S5 functions the tick answers {ok:false} and does not throw', r && r.ok === false && !r.threw, j(r));
  const env3 = fresh(); stubs(env3, {}); env3.ctx.fu2_logic_dueNow_ = () => { throw new Error('engine broke'); };
  try { r = env3.ctx.fu2_notify_tick_(); } catch (e) { r = { threw: String(e) }; }
  t('an engine error does not throw out of the tick', r && r.ok === false && !r.threw, j(r));
  const env4 = fresh(), st4 = {}; stubs(env4, st4); st4.items = [item({})]; env4.props.TELEGRAM_ADMIN_CHAT_ID = '';
  r = env4.ctx.fu2_notify_tick_();
  t('no chat configured: nothing sent, nothing logged, no throw', r.ok && env4.sent().length === 0 && !env4.getSS('DATA').getSheetByName('FollowupNotifications'), j(r));
  const env5 = fresh(), st5 = {}; stubs(env5, st5); st5.items = [item({})]; env5.lockState.busy = true;
  r = env5.ctx.fu2_notify_tick_();
  t('busy lock: the tick exits without sending', r.ok && r.busy && env5.sent().length === 0, j(r));
  env5.lockState.busy = false; env5.ctx.fu2_notify_tick_();
  t('...and sends on the next tick (nothing was lost)', env5.sent().length === 2);
}

// ============ 7. A failing Telegram never fails the tick, and nothing is lost ============
{
  const env = fresh(), st = {}; stubs(env, st); st.items = [item({})];
  env.net.fail = true;
  let r; try { r = env.ctx.fu2_notify_tick_(); } catch (e) { r = { threw: String(e) }; }
  t('network error: tick still answers ok, no throw', r && r.ok === true && !r.threw && r.sent === 0 && r.failed === 1, j(r));
  const lg = env.getSS('DATA').getSheetByName('FollowupNotifications');
  t('...and the claim is given back (log has no row)', lg.getLastRow() === 1, lg.getLastRow());
  env.net.fail = false; env.net.code = 500; r = env.ctx.fu2_notify_tick_();
  t('HTTP 500 counts as a failure too', r.ok && r.sent === 0 && r.failed === 1 && lg.getLastRow() === 1, j(r));
  env.net.code = 200; r = env.ctx.fu2_notify_tick_();
  t('when Telegram is back the same event is sent once', r.sent === 1 && lg.getLastRow() === 2, j(r));
  // One chat down, one up -> counts as sent
  const e2 = fresh(), s2 = {}; stubs(e2, s2); s2.items = [item({})];
  let n = 0; const real = e2.ctx.UrlFetchApp.fetch; e2.ctx.UrlFetchApp.fetch = (u, o) => { if (JSON.parse(o.payload).chat_id === '111') throw new Error('blocked'); return real(u, o); };
  r = e2.ctx.fu2_notify_tick_();
  t('one chat failing does not stop the other, and the event is logged once', r.sent === 1 && e2.sent().length === 1 && e2.sent()[0].body.chat_id === '222' && e2.getSS('DATA').getSheetByName('FollowupNotifications').getLastRow() === 2, j(r));
}

// ============ 8. Telegram callbacks ============
{
  const env = fresh(), st = {}; stubs(env, st);
  const cb = (data, id) => env.ctx.fu2_notify_telegramCallback_({ id: 'q', from: { id: id === undefined ? 111 : id }, data });
  let v = cb('fu:snooze:sat-1800');
  t('snooze: verdict mentions the date and Alex', /2026-11-07/.test(v) && /Alex/.test(v) && !/Cairo/i.test(v), v);
  const g = env.ctx.fu2_notify_routes_().admin_fu2_notify_settings_get({ token: 'tok' });
  t('snooze wrote snooze_until = tomorrow in NotifySettings', g.ok && g.groups['sat-1800'] && g.groups['sat-1800'].snooze_until === '2026-11-07' && g.groups['sat-1800'].enabled === true, j(g));
  env.setNow('2026-11-06T23:59:00+02:00'); cb('fu:snooze:sun-1000');
  t('snooze "tomorrow" is by Alex date even at 23:59', env.ctx.fu2_notify_routes_().admin_fu2_notify_settings_get({ token: 'tok' }).groups['sun-1000'].snooze_until === '2026-11-07');
  env.setNow('2026-10-29T23:30:00+03:00'); cb('fu:snooze:dst1'); env.setNow('2026-10-30T23:30:00+02:00'); cb('fu:snooze:dst2'); // around the autumn clock change
  const sg = env.ctx.fu2_notify_routes_().admin_fu2_notify_settings_get({ token: 'tok' }).groups;
  t('snooze around the autumn clock change keeps calendar days', sg.dst1.snooze_until === '2026-10-30' && sg.dst2.snooze_until === '2026-10-31', j([sg.dst1, sg.dst2]));
  env.setNow(FRI_EVE);
  v = cb('fu:done:sat-1800:remind_hw:2026-11-07');
  t('done remind_hw -> FollowupDone "hw|date"', /Marked done/.test(v), v);
  v = cb('fu:done:sat-1800:remind_watch:2026-11-07'); cb('fu:done:sat-1800:advance_lessons:2026-10-31');
  const ov = { groups: [{ key: 'sat-1800' }] }; env.ctx.fu2_notify_overviewHook_(ov);
  t('done kinds map: remind_watch->watch, remind_hw->hw, advance_lessons->advance', j(ov.groups[0].done) === '["hw|2026-11-07","watch|2026-11-07","advance|2026-10-31"]', j(ov.groups[0].done));
  for (const k of ['parents_watch', 'parents_hw', 'attendance', 'setup_missing']) {
    v = cb('fu:done:sat-1800:' + k + ':2026-11-07');
    t('done on ' + k + ' -> "Nothing to mark", nothing written', /Nothing to mark/.test(v) && env.getSS('DATA').getSheetByName('FollowupDone').getLastRow() === 4, v);
  }
  const rows = () => env.getSS('DATA').getSheetByName('NotifySettings').getLastRow();
  const n0 = rows(), d0 = env.getSS('DATA').getSheetByName('FollowupDone').getLastRow();
  v = cb('fu:snooze:evil', 999); const v2 = cb('fu:done:sat-1800:remind_hw:2026-12-12', '999');
  t('a tap from someone who is not a configured admin writes nothing', /Not allowed/.test(v) && /Not allowed/.test(v2) && rows() === n0 && env.getSS('DATA').getSheetByName('FollowupDone').getLastRow() === d0, v + '|' + v2);
  t('garbage / null callbacks return a line and never throw', typeof cb('fu:wat') === 'string' && typeof cb('') === 'string' && typeof env.ctx.fu2_notify_telegramCallback_(null) === 'string' && typeof env.ctx.fu2_notify_telegramCallback_({}) === 'string');
  v = cb('fu:done:sat-1800:remind_hw:not-a-date');
  t('a malformed done payload is refused', !/Marked done/.test(v), v);
  v = cb('fu:done:key:with:colons:remind_hw:2026-11-07');
  const g2 = env.ctx.fu2_notify_routes_().admin_fu2_mark_done({ token: 'tok', group: 'key:with:colons', kind: 'hw', session_date: '2026-11-07' });
  t('group keys containing ":" round-trip through the done payload', /Marked done/.test(v) && j(g2.done) === '["hw|2026-11-07"]', v + j(g2));
  // Tap, then the next tick, end to end: snoozing from Telegram silences the group
  const e2 = fresh(), s2 = {}; stubs(e2, s2); s2.items = [item({})];
  e2.ctx.fu2_notify_telegramCallback_({ from: { id: 111 }, data: 'fu:snooze:sat-1800' }); e2.ctx.fu2_notify_tick_();
  t('end to end: snooze tapped in Telegram silences the next tick', e2.sent().length === 0);
}

// ============ 9. The actions ============
{
  const env = fresh(); const R = env.ctx.fu2_notify_routes_(), adm = { token: 'tok' };
  t('routes expose exactly the four actions', j(Object.keys(R).sort()) === j(['admin_fu2_mark_done', 'admin_fu2_notify_settings_get', 'admin_fu2_notify_settings_save', 'admin_fu2_notify_test']));
  for (const [name, p] of [['admin_fu2_mark_done', { group: 'g', kind: 'hw', session_date: '2026-11-07' }], ['admin_fu2_notify_settings_get', {}], ['admin_fu2_notify_settings_save', { group: 'g', enabled: false }], ['admin_fu2_notify_test', {}]]) {
    const bad = R[name]({ ...p, token: 'wrong' }), none = R[name](p);
    t(name + ': no/incorrect staff credentials -> {ok:false,error}', bad.ok === false && /Not authorized/.test(bad.error) && none.ok === false && !!none.error, j(bad) + j(none));
  }
  let r = R.admin_fu2_mark_done({ ...adm, group: 'g1', kind: 'watch', session_date: '2026-11-07' });
  t('mark_done returns the full done list', r.ok && j(r.done) === '["watch|2026-11-07"]', j(r));
  r = R.admin_fu2_mark_done({ ...adm, group: 'g1', kind: 'watch', session_date: '2026-11-07' });
  t('mark_done twice is idempotent (one row)', r.ok && r.done.length === 1 && env.getSS('DATA').getSheetByName('FollowupDone').getLastRow() === 2, j(r));
  r = R.admin_fu2_mark_done({ ...adm, group: 'g1', kind: 'advance', session_date: '2026-10-31' });
  t('second kind is appended to the list', j(r.done) === '["watch|2026-11-07","advance|2026-10-31"]', j(r));
  for (const bad of [{ kind: 'hw', session_date: '2026-11-07' }, { group: 'g', kind: 'parents_hw', session_date: '2026-11-07' }, { group: 'g', kind: 'hw', session_date: '7/11/2026' }, { group: 'g', kind: 'hw' }]) {
    r = R.admin_fu2_mark_done({ ...adm, ...bad });
    t('mark_done rejects ' + j(bad), r.ok === false && !!r.error, j(r));
  }
  t('done sheet keeps the date as text', env.getSS('DATA').getSheetByName('FollowupDone').get(2, 3) === '2026-11-07');
  for (const bad of [{ hour: 24 }, { hour: -1 }, { hour: 'x' }, { hour: 9.5 }, { hour: '' }, { snooze_until: '07/11/2026' }, { group: '' }]) {
    r = R.admin_fu2_notify_settings_save({ ...adm, group: 'g1', ...bad });
    t('settings_save rejects ' + j(bad), r.ok === false && !!r.error, j(r));
  }
  r = R.admin_fu2_notify_settings_save({ ...adm, group: 'g1', hour: 0 });
  t('hour 0 is valid', r.ok && r.settings.hour === 0, j(r));
  r = R.admin_fu2_notify_settings_save({ ...adm, group: 'g1', hour: '23', enabled: 'false' });
  t('hour "23" and enabled "false" are understood; unsent fields keep their value', r.ok && r.settings.hour === 23 && r.settings.enabled === false && r.settings.snooze_until === '', j(r));
  const sh = env.getSS('DATA').getSheetByName('NotifySettings');
  R.admin_fu2_notify_settings_save({ ...adm, group: 'g1', snooze_until: '2026-12-01' }); R.admin_fu2_notify_settings_save({ ...adm, group: 'g2', hour: 7 });
  t('one row per group (updates in place)', sh.getLastRow() === 3, sh.getLastRow());
  r = R.admin_fu2_notify_settings_get(adm);
  t('settings_get lists groups with a row', r.ok && r.groups.g1.hour === 23 && r.groups.g1.snooze_until === '2026-12-01' && r.groups.g2.hour === 7 && r.groups.g2.enabled === true, j(r));
  // A date cell that Sheets turned into a real Date is read back as text
  sh.set(2, 4, new Date('2026-12-01T00:00:00+02:00'));
  r = R.admin_fu2_notify_settings_get(adm);
  t('a Date in the snooze cell is read as yyyy-MM-dd', r.groups.g1.snooze_until === '2026-12-01', j(r));
  r = R.admin_fu2_notify_test(adm);
  t('notify_test: sends to every configured chat', r.ok && r.sent_to === 2 && env.sent().length === 2 && env.sent().every(c => /Test from Follow-up/.test(c.body.text) && /Alex/.test(c.body.text)), j(r));
  r = env.ctx.fu2_notify_sendTest();
  t('editor helper fu2_notify_sendTest sends the test and is not a route', r.ok && r.sent_to === 2 && !Object.keys(R).includes('fu2_notify_sendTest'), j(r));
  env.net.fail = true; r = R.admin_fu2_notify_test(adm);
  t('notify_test with Telegram down: ok, sent_to 0, no throw', r.ok && r.sent_to === 0, j(r));
  env.net.fail = false;
  // AuditLog
  const au = env.getSS('DATA').getSheetByName('AuditLog');
  let acts = []; for (let i = 2; au && i <= au.getLastRow(); i++) acts.push(au.get(i, 3));
  t('writes leave AuditLog rows (mark done, settings)', acts.includes('fu2_mark_done') && acts.includes('fu2_notify_settings'), j(acts));
}

// ============ 10. Trigger ============
{
  const env = fresh();
  env.ctx.fu2_notify_installTrigger(); env.ctx.fu2_notify_installTrigger();
  t('installTrigger is hourly and replaces the previous one (one trigger)', env.triggers.length === 1 && env.triggers[0].hours === 1 && env.triggers[0].fn === 'fu2_notify_tick', j(env.triggers.map(x => [x.fn, x.hours])));
  env.ctx.ScriptApp.newTrigger('weeklyBackup').timeBased().create();
  env.ctx.fu2_notify_removeTrigger();
  t('removeTrigger removes ours only', env.triggers.length === 1 && env.triggers[0].fn === 'weeklyBackup');
  const st = {}; stubs(env, st); st.items = [item({})];
  const r = env.ctx.fu2_notify_tick();
  t('the public trigger entry runs the tick', r.ok && env.sent().length === 2, j(r));
}

// ============ 11. Nothing outside our three sheets is created or touched ============
{
  const env = fresh(), st = {}; stubs(env, st); st.items = [item({})];
  env.ctx.fu2_notify_tick_(); env.ctx.fu2_notify_routes_().admin_fu2_mark_done({ token: 'tok', group: 'g', kind: 'hw', session_date: '2026-11-07' });
  env.ctx.fu2_notify_routes_().admin_fu2_notify_settings_save({ token: 'tok', group: 'g', hour: 9 });
  const names = [...env.getSS('DATA').getSheets(), ...env.getSS('STU').getSheets()].map(s => s.name).sort();
  t('only FollowupNotifications, FollowupDone, NotifySettings, AuditLog (+ Students) exist', j(names) === j(['AuditLog', 'FollowupDone', 'FollowupNotifications', 'NotifySettings', 'Students']), j(names));
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
