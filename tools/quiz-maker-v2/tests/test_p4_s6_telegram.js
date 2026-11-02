// P4 / S6 - Telegram per teacher: link flow, routing, callback authorization, replay, owner ping, unlink.
// Usage (from tools/quiz-maker-v2/): node tests/test_p4_s6_telegram.js
// Builds the real Code.gs (the two S6 hooks are applied in memory when Code.gs does not have them yet) + Phase4_Telegram.gs,
// stubs the S2/S3 functions named in the contract (section 9) and a fake Telegram. Nothing touches the network.
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os'), crypto = require('crypto');
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

const APPS = path.join(__dirname, '..', 'apps_script');
const CODE_PATH = path.join(APPS, 'Code.gs');
const P4TG = [path.join(APPS, 'chunks', 'Phase4_Telegram.gs'), path.join(APPS, 'Phase4_Telegram.gs')].find(fs.existsSync);
const MERGED = /MERGED FROM Phase4_Telegram\.gs/.test(fs.readFileSync(CODE_PATH, 'utf8'));

// Code.gs with the two S6 hooks (identical to patches/S6-telegram.diff). A no-op when the hooks are already there.
function codeFile() {
  let s = fs.readFileSync(CODE_PATH, 'utf8');
  if (/p4_tg_handleUpdate/.test(s)) return CODE_PATH;
  const nl = s.includes('\r\n') ? '\r\n' : '\n', fx = x => x.replace(/\n/g, nl);
  const a = fx('        console.error("notifyAdmin failed for " + id + ": " + err);\n      }\n    });\n  } catch (err) {');
  const b = fx('    if (!secret || !e || !e.parameter || e.parameter.tg !== secret) return _json({ ok: true });\n    var cq = update && update.callback_query;');
  if (s.split(a).length !== 2 || s.split(b).length !== 2) throw new Error('hook anchors not found in Code.gs');
  s = s.replace(a, fx('        console.error("notifyAdmin failed for " + id + ": " + err);\n      }\n    });\n    if (paymentId) {\n      try { if (typeof p4_tg_notifyPayment === "function") p4_tg_notifyPayment(paymentId); } catch (e) {}\n    }\n  } catch (err) {'));
  s = s.replace(b, fx('    if (!secret || !e || !e.parameter || e.parameter.tg !== secret) return _json({ ok: true });\n    if (typeof p4_tg_handleUpdate === "function" && p4_tg_handleUpdate(update)) return _json({ ok: true });\n    var cq = update && update.callback_query;'));
  const f = path.join(os.tmpdir(), 'p4s6_code_' + process.pid + '.gs'); fs.writeFileSync(f, s); return f;
}

const BOT_TOKEN = '123456:SECRET-BOT-TOKEN';
const PAY_HEADERS = ['payment_id', 'phone', 'name', 'scope', 'reference', 'note', 'status', 'created_at', 'decided_at'];
const MATH = 'math/sat/lesson-1', PROG = 'programming/baccalaureate/grade-2-secondary/lesson-1';
const T1 = '01099999991', T2 = '01099999992', OWNER_CHAT = '111';

function build(opts = {}) {
  const files = [codeFile()]; if (!MERGED) files.push(P4TG);
  const props = Object.assign({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID: OWNER_CHAT, TELEGRAM_WEBHOOK_SECRET: 'sec', P4_TG_BOT_USERNAME: 'MyBot' }, opts.props || {});
  const env = load(files, { clock: true, props });
  const ctx = env.ctx;
  const calls = [], logs = []; let mid = 1000, failFetch = false;
  // Real SHA-256 and a recording fake Telegram (the harness digest is MD5 only).
  const baseU = ctx.Utilities;
  ctx.Utilities = Object.assign({}, baseU, {
    DigestAlgorithm: { MD5: 'md5', SHA_256: 'sha256' },
    computeDigest: (alg, s) => [...crypto.createHash(alg === 'sha256' ? 'sha256' : 'md5').update(String(s)).digest()].map(b => (b > 127 ? b - 256 : b)),
  });
  ctx.UrlFetchApp = { fetch: (url, o) => {
    const method = String(url).split('/').pop(), body = JSON.parse(o.payload);
    if (failFetch) throw new Error('Request failed for ' + url + ' returned code 500');
    calls.push({ method, body });
    return { getContentText: () => JSON.stringify({ ok: true, result: { message_id: ++mid } }) };
  } };
  ctx.console = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };
  // Stubs for S2 / S3 (contract section 9). TEST_TEACHERS: phone -> ctx. MATH_PAYS: payment ids that are "in scope" for math.
  ctx.TEST_TEACHERS = {}; ctx.TEST_CTX = { kind: 'anon', via: 'none', id: '', subjects: [], principal: '' }; ctx.MATH_PAYS = {}; ctx.PROG_PAYS = {};
  vm.runInContext(`
    function p4_subjectOf(k){ return String(k||'').split('#')[0].split('/')[0].toLowerCase(); }
    function p4_ctx(){ return TEST_CTX; }
    function p4_ctxForPhone(ph){ return TEST_TEACHERS[ph] || null; }
    function p4_teacherCovers(c,k){ return c.kind==='owner' || c.subjects.indexOf(p4_subjectOf(k)) !== -1; }
    function p4_paymentInScope(c,p){ if (c.kind==='owner') return true; var id = String(p.payment_id);
      return c.subjects.indexOf('math') !== -1 && !!MATH_PAYS[id] || c.subjects.indexOf('programming') !== -1 && !!PROG_PAYS[id]; }
  `, ctx);
  const sheets = n => env.getSS('STU').getSheetByName(n);
  const ensure = (name, headers) => { let sh = sheets(name); if (!sh) { sh = env.getSS('STU').insertSheet(name); sh.appendRow(headers); } return sh; };
  const rows = n => { const sh = sheets(n); if (!sh) return []; const o = []; for (let r = 2; r <= sh.getLastRow(); r++) { const row = {}; for (let c = 1; c <= 12; c++) if (sh.get(1, c)) row[sh.get(1, c)] = sh.get(r, c); o.push(row); } return o; };
  let n = 0;
  const api = { env, ctx, calls, logs, props: env.props, cache: env.cache, rows, setFail: v => { failFetch = v; } };
  api.addPay = (scope, o = {}) => {
    const id = o.id || 'pay' + (++n);
    ensure('Payments', PAY_HEADERS).appendRow([id, o.phone || '01011112222', o.name || 'Sara', scope, o.ref || 'REF' + n, o.note || '', o.status || 'pending', '2026-10-30 10:00:00', '']);
    if (/^math/.test(scope)) ctx.MATH_PAYS[id] = true; else ctx.PROG_PAYS[id] = true;
    return id;
  };
  api.status = id => (rows('Payments').find(r => r.payment_id === id) || {}).status;
  api.teacher = (phone, subjects) => { ctx.TEST_TEACHERS[phone] = { kind: 'teacher', via: 'telegram', id: phone, subjects, principal: phone }; };
  api.callerCtx = c => { ctx.TEST_CTX = c; };
  api.asTeacher = (phone, subjects) => api.callerCtx({ kind: 'teacher', via: 'session', id: phone, subjects: subjects || ['math'], principal: phone });
  api.send = (m, body) => calls.filter(c => c.method === m && (!body || Object.keys(body).every(k => String(c.body[k]) === String(body[k]))));
  api.reset = () => { calls.length = 0; logs.length = 0; };
  let uid = 1;
  api.start = (chat, code, extra) => ({ update_id: ++uid, message: Object.assign({ chat: { id: chat, type: 'private' }, from: { id: chat }, text: '/start ' + code }, extra || {}) });
  api.tap = (chat, kind, pid, extra, type) => ({ update_id: ++uid, callback_query: Object.assign({ id: 'cq' + uid, from: { id: chat }, data: kind + ':' + pid, message: { message_id: 500 + uid, chat: { id: chat, type: type || 'private' }, text: 'Payment request\n\nSara' } }, extra || {}) });
  api.handle = u => ctx.p4_tg_handleUpdate(u);
  api.hook = (u, secret) => JSON.parse(ctx.doPost({ parameter: secret === undefined ? { tg: 'sec' } : (secret === null ? {} : { tg: secret }), postData: { contents: JSON.stringify(u) } }).text);
  // Link a teacher through the real flow; returns the raw code.
  api.link = (phone, chat, subjects) => {
    api.teacher(phone, subjects || ['math']); api.asTeacher(phone, subjects || ['math']);
    const r = ctx.p4_tg_link_start({}); const code = /start=([A-Z2-9]+)$/.exec(r.link)[1];
    api.handle(api.start(chat, code)); return code;
  };
  return api;
}

// ---- 1. link_start: who may call it, what is stored
{
  const a = build();
  a.asTeacher(T1); a.teacher(T1, ['math']);
  const r = a.ctx.p4_tg_link_start({});
  t('link_start: teacher gets {ok, link, expires_in:900}', r.ok === true && r.expires_in === 900 && /^https:\/\/t\.me\/MyBot\?start=[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(r.link), JSON.stringify(r));
  const code = /start=(\w+)$/.exec(r.link)[1];
  const keys = Object.keys(a.cache);
  const hashed = crypto.createHash('sha256').update(code).digest('hex');
  t('link code is stored only as SHA-256 under p4tg:<hash>, never raw', keys.includes('p4tg:' + hashed) && !keys.some(k => k.includes(code)) && !Object.values(a.cache).some(v => String(v).includes(code)), keys.join(','));
  t('stored value is the teacher id, not secret data', a.cache['p4tg:' + hashed] === T1);
  a.callerCtx({ kind: 'assistant', via: 'session', id: '01055555555', subjects: ['math'], principal: T1 });
  t('assistant cannot link Telegram', JSON.stringify(a.ctx.p4_tg_link_start({})) === JSON.stringify({ ok: false, error: 'Not authorized.' }));
  a.callerCtx({ kind: 'teacher', via: 'token', id: 'Mr X', subjects: ['math'], principal: '' });
  t('a desktop token caller cannot link (needs a session)', a.ctx.p4_tg_link_start({}).error === 'Not authorized.');
  a.callerCtx({ kind: 'owner', via: 'session', id: '010', subjects: ['*'], principal: '' });
  t('owner/student/anon are refused too', a.ctx.p4_tg_link_start({}).error === 'Not authorized.');
  a.callerCtx({ kind: 'student', via: 'session', id: '012', subjects: [], principal: '' });
  t('student refused', a.ctx.p4_tg_link_start({}).error === 'Not authorized.');
  a.asTeacher(T2); a.teacher(T2, ['math']);
  let okN = 0; for (let i = 0; i < 7; i++) if (a.ctx.p4_tg_link_start({}).ok) okN++;
  t('at most 5 link starts per hour per teacher', okN === 5, 'ok=' + okN);
  a.asTeacher(T1);
  t('another teacher has his own bucket (T1 used 1)', a.ctx.p4_tg_link_start({}).ok === true);
  const b = build({ props: { P4_TG_BOT_USERNAME: '' } }); b.asTeacher(T1);
  t('no bot username configured -> clear setup message, no code stored', b.ctx.p4_tg_link_start({}).ok === false && !Object.keys(b.cache).some(k => k.startsWith('p4tg:')));
}

// ---- 2. /start link flow
{
  const a = build();
  a.teacher(T1, ['math']); a.asTeacher(T1);
  const code = /start=(\w+)$/.exec(a.ctx.p4_tg_link_start({}).link)[1];
  t('/start from a GROUP chat is not handled', a.handle(a.start(-100, code, { chat: { id: -100, type: 'group' } })) === false && a.rows('TeacherTelegram').length === 0);
  t('/start with no code is not handled', a.handle(a.start(777, '').constructor === Object && { update_id: 900, message: { chat: { id: 777, type: 'private' }, from: { id: 777 }, text: '/start' } }) === false);
  a.reset();
  t('wrong code: handled silently, no reply at all', a.handle(a.start(777, 'ZZZZZZZZ')) === true && a.calls.length === 0 && a.rows('TeacherTelegram').length === 0);
  t('message from a different user than the chat is a silent no-op', a.handle(a.start(777, code, { from: { id: 888 } })) === true && a.calls.length === 0 && a.rows('TeacherTelegram').length === 0);
  a.reset();
  t('good code: handled', a.handle(a.start(777, code)) === true);
  const rows = a.rows('TeacherTelegram');
  t('row stored: teacher id + chat id + time', rows.length === 1 && rows[0].teacher_id === T1 && String(rows[0].chat_id) === '777' && !!rows[0].linked_at, JSON.stringify(rows));
  const ack = a.send('sendMessage', { chat_id: 777 })[0];
  t('reply says "Connected. You will receive payment requests for: math."', ack && ack.body.text === 'Connected. You will receive payment requests for: math.', JSON.stringify(ack));
  a.reset();
  t('same code again: single use, silent no-op', a.handle(a.start(778, code)) === true && a.calls.length === 0 && a.rows('TeacherTelegram').length === 1);
  t('expired code behaves exactly like a wrong code (no reply)', (() => { a.asTeacher(T1); const c2 = /start=(\w+)$/.exec(a.ctx.p4_tg_link_start({}).link)[1]; delete a.cache['p4tg:' + crypto.createHash('sha256').update(c2).digest('hex')]; a.reset(); const r = a.handle(a.start(779, c2)); return r === true && a.calls.length === 0; })());
  t('the raw code is not in the sheet or the logs', !JSON.stringify(a.rows('TeacherTelegram')).includes(code) && !a.logs.join('\n').includes(code));
  // re-link: new chat replaces the old row; a chat can belong to one teacher only
  a.asTeacher(T1); const c3 = /start=(\w+)$/.exec(a.ctx.p4_tg_link_start({}).link)[1]; a.handle(a.start(780, c3));
  t('a new link replaces the teacher\'s old row', a.rows('TeacherTelegram').length === 1 && String(a.rows('TeacherTelegram')[0].chat_id) === '780');
  a.teacher(T2, ['math']); a.asTeacher(T2); const c4 = /start=(\w+)$/.exec(a.ctx.p4_tg_link_start({}).link)[1]; a.handle(a.start(780, c4));
  t('a chat linked by a second teacher replaces the first (one teacher per chat)', (() => { const r = a.rows('TeacherTelegram'); return r.length === 1 && r[0].teacher_id === T2; })());
  // role lost between code issue and tap
  a.asTeacher(T1); const c5 = /start=(\w+)$/.exec(a.ctx.p4_tg_link_start({}).link)[1]; delete a.ctx.TEST_TEACHERS[T1]; a.reset();
  t('teacher who lost the role before tapping: nothing linked, no reply, code consumed', a.handle(a.start(781, c5)) === true && a.calls.length === 0 && a.rows('TeacherTelegram').every(r => r.teacher_id !== T1));
}

// ---- 3. routing of payment pings
{
  const a = build();
  a.link(T1, 1001, ['math']); a.link(T2, 1002, ['programming']);
  a.teacher('01099999993', ['math']); // a third teacher who never linked Telegram
  a.reset();
  const m = a.addPay(MATH, { name: 'Sara <b>&', ref: 'R&1' });
  a.ctx._notifyAdmin('x', m);
  const to = id => a.send('sendMessage', { chat_id: id });
  t('owner still gets the original message', to(OWNER_CHAT).length === 1 && to(OWNER_CHAT)[0].body.reply_markup.inline_keyboard[0][0].callback_data === 'ap:' + m);
  t('math teacher gets the math payment with Approve/Reject', to(1001).length === 1 && to(1001)[0].body.reply_markup.inline_keyboard[0].map(b => b.callback_data).join() === 'ap:' + m + ',rj:' + m);
  t('programming teacher gets nothing for a math payment', to(1002).length === 0);
  const txt = to(1001)[0].body.text;
  t('teacher message is built from the payment row only (name, phone, lesson, ref), HTML escaped', /Sara &lt;b&gt;&amp;/.test(txt) && /01011112222/.test(txt) && /R&amp;1/.test(txt) && !/<b>&/.test(txt.replace('<b>Payment request</b>', '')), txt);
  a.reset();
  const p = a.addPay(PROG); a.ctx._notifyAdmin('x', p);
  t('programming payment goes to the programming teacher only', to(1002).length === 1 && to(1001).length === 0);
  a.reset();
  a.ctx._notifyAdmin('Homework submitted (no payment id)');
  t('messages without a payment id never reach teachers', to(1001).length === 0 && to(1002).length === 0);
  a.reset(); delete a.ctx.TEST_TEACHERS[T1];
  const m2 = a.addPay(MATH); a.ctx._notifyAdmin('x', m2);
  t('a teacher who lost his role gets no ping', to(1001).length === 0);
  a.teacher(T1, ['math']); a.reset();
  const done = a.addPay(MATH, { status: 'approved' }); a.ctx._notifyAdmin('x', done);
  t('an already decided payment is not pinged', to(1001).length === 0);
  // owner chat registered as a teacher chat: no duplicate message
  const b = build(); b.link(T1, Number(OWNER_CHAT), ['math']); b.reset();
  const bm = b.addPay(MATH); b.ctx._notifyAdmin('x', bm);
  t('a teacher chat equal to the owner chat gets no duplicate', b.send('sendMessage', { chat_id: Number(OWNER_CHAT) }).length === 1);
  // a chat listed twice is deduplicated
  const c = build(); c.link(T1, 1001, ['math']); c.ctx.p4tg_sheet_(true).appendRow([T2, '1001', 'x']); c.teacher(T2, ['math']); c.reset();
  const cm = c.addPay(MATH); c.ctx._notifyAdmin('x', cm);
  t('ambiguous chat (two teachers on one chat) gets at most one message', c.send('sendMessage', { chat_id: 1001 }).length <= 1);
}

// ---- 4. callback matrix
{
  const a = build();
  a.link(T1, 1001, ['math']);
  const m1 = a.addPay(MATH), pr = a.addPay(PROG);
  a.ctx._notifyAdmin('x', m1);
  a.reset();
  // owner chat: not ours
  t('owner chat tap -> false (existing path decides)', a.handle(a.tap(Number(OWNER_CHAT), 'ap', m1)) === false && a.calls.length === 0 && a.status(m1) === 'pending');
  t('unknown private chat -> false, no state change, no reply', a.handle(a.tap(4242, 'ap', m1)) === false && a.status(m1) === 'pending' && a.calls.length === 0);
  t('registered chat but GROUP chat type -> false', a.handle(a.tap(1001, 'ap', m1, null, 'supergroup')) === false && a.status(m1) === 'pending');
  t('tap whose user id differs from the chat -> false', a.handle(a.tap(1001, 'ap', m1, { from: { id: 9999 } })) === false && a.status(m1) === 'pending');
  t('non ap/rj callback data -> false', a.handle(a.tap(1001, 'zz', m1)) === false);
  t('plain text message from a teacher chat -> false', a.handle({ update_id: 5000, message: { chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: 'hello' } }) === false);
  a.reset();
  // out of scope: programming payment tapped from the math teacher's chat
  t('math teacher taps a programming payment: handled, refused', a.handle(a.tap(1001, 'ap', pr)) === true && a.status(pr) === 'pending');
  t('...and the reply carries no detail (only the spinner clear)', a.calls.every(c => c.method === 'answerCallbackQuery' && !c.body.text) && a.calls.length === 1, JSON.stringify(a.calls));
  a.reset();
  t('forged payment id: refused, no state change', a.handle(a.tap(1001, 'ap', 'pFORGED')) === true && a.rows('Payments').every(r => r.status === 'pending') && a.calls.every(c => c.method === 'answerCallbackQuery'));
  a.reset();
  // success
  const u = a.tap(1001, 'ap', m1);
  t('teacher approves an in-scope payment', a.handle(u) === true && a.status(m1) === 'approved');
  t('...the SAME internal decision ran: entitlement written for that student and scope', a.rows('Entitlements').some(r => r.scope === MATH && String(r.phone).endsWith('11112222')), JSON.stringify(a.rows('Entitlements')));
  t('spinner cleared first', a.calls[0].method === 'answerCallbackQuery' && a.calls[0].body.callback_query_id === 'cq' + u.update_id);
  const ed = a.send('editMessageText')[0];
  t('teacher\'s message edited to "Approved" and buttons removed', ed && /Approved$/.test(ed.body.text) && !('reply_markup' in ed.body), JSON.stringify(ed));
  const ping = a.send('sendMessage', { chat_id: OWNER_CHAT }).map(c => c.body.text);
  t('owner gets a ping about the teacher decision', ping.length === 1 && /by teacher 01099999991/.test(ping[0]) && ping[0].includes(m1), JSON.stringify(ping));
  t('owner ping is plain text (no parse_mode)', !('parse_mode' in a.send('sendMessage', { chat_id: OWNER_CHAT })[0].body));
  // replay of the same update (Telegram retry)
  a.reset();
  t('replay of the same update id: handled, nothing happens', a.handle(u) === true && a.calls.length === 0);
  // second tap on the same payment (new update id)
  a.reset();
  t('second tap on a decided payment: "Already decided", first decision kept', a.handle(a.tap(1001, 'rj', m1)) === true && a.status(m1) === 'approved' && /Already decided$/.test(a.send('editMessageText')[0].body.text));
  t('no owner ping on a stale tap', a.send('sendMessage', { chat_id: OWNER_CHAT }).length === 0);
  // reject path
  const m2 = a.addPay(MATH); a.reset();
  t('teacher rejects', a.handle(a.tap(1001, 'rj', m2)) === true && a.status(m2) === 'rejected' && /Rejected$/.test(a.send('editMessageText')[0].body.text));
  // owner decided first (race): teacher tap is a no-op
  const m3 = a.addPay(MATH); a.ctx.handleAdminDecidePayment({ token: 'tok', payment_id: m3, decision: 'approve' }); a.reset();
  t('owner decided first: teacher\'s late tap says "Already decided" and changes nothing', a.handle(a.tap(1001, 'rj', m3)) === true && a.status(m3) === 'approved' && /Already decided/.test(a.send('editMessageText')[0].body.text));
  // role / scope lost
  const m4 = a.addPay(MATH); a.reset(); const saved = a.ctx.TEST_TEACHERS[T1]; delete a.ctx.TEST_TEACHERS[T1];
  t('teacher who lost his role: refused, no state change', a.handle(a.tap(1001, 'ap', m4)) === true && a.status(m4) === 'pending' && a.calls.every(c => c.method === 'answerCallbackQuery'));
  a.ctx.TEST_TEACHERS[T1] = Object.assign({}, saved, { subjects: ['programming'] }); a.reset();
  t('teacher whose scope changed to another subject: refused', a.handle(a.tap(1001, 'ap', m4)) === true && a.status(m4) === 'pending');
  a.ctx.TEST_TEACHERS[T1] = saved;
  // assistant-like ctx (kind != teacher) is refused
  a.ctx.TEST_TEACHERS[T1] = Object.assign({}, saved, { kind: 'assistant' }); a.reset();
  t('a chat whose person is now an assistant cannot decide', a.handle(a.tap(1001, 'ap', m4)) === true && a.status(m4) === 'pending');
  a.ctx.TEST_TEACHERS[T1] = saved;
  // a request payload field cannot widen anything: the decision is made without any scope override
  const m5 = a.addPay(MATH); a.reset(); a.handle(a.tap(1001, 'ap', m5 + ' scope:programming'));
  t('crafted callback text with extra tokens is not a valid payment id', a.status(m5) === 'pending');
}

// ---- 5. buttons removed everywhere after a decision
{
  const a = build();
  a.link(T1, 1001, ['math']); a.link(T2, 1002, ['math']); a.reset();
  const m = a.addPay(MATH); a.ctx._notifyAdmin('x', m);
  const first = a.send('sendMessage', { chat_id: 1001 })[0], second = a.send('sendMessage', { chat_id: 1002 })[0];
  t('two linked math teachers both get the ping', !!first && !!second);
  const id1 = a.calls.indexOf(first), id2 = a.calls.indexOf(second);
  void id1; void id2;
  const mids = JSON.parse(a.cache['p4tgm:' + m]);
  t('message ids are remembered per payment', mids.length === 2 && mids.every(x => x.m > 1000));
  a.reset();
  a.handle({ update_id: 7001, callback_query: { id: 'q', from: { id: 1001 }, data: 'ap:' + m, message: { message_id: mids.find(x => String(x.c) === '1001').m, chat: { id: 1001, type: 'private' }, text: 'Payment request' } } });
  const strip = a.send('editMessageReplyMarkup');
  t('first decision wins and the other teacher\'s buttons are removed', a.status(m) === 'approved' && strip.length === 1 && String(strip[0].body.chat_id) === '1002' && strip[0].body.reply_markup.inline_keyboard.length === 0, JSON.stringify(strip));
  a.reset();
  a.handle(a.tap(1002, 'rj', m));
  t('the other teacher\'s late tap says "Already decided"', a.status(m) === 'approved' && /Already decided/.test(a.send('editMessageText')[0].body.text));
}

// ---- 6. real webhook path: doPost -> handleTelegramUpdate (secret first, then S6)
{
  const a = build();
  a.teacher(T1, ['math']); a.asTeacher(T1);
  const code = /start=(\w+)$/.exec(a.ctx.p4_tg_link_start({}).link)[1];
  a.reset();
  a.hook(a.start(555, code), null);
  t('webhook update WITHOUT the secret is ignored (cannot link a chat)', a.rows('TeacherTelegram').length === 0 && a.calls.length === 0);
  a.hook(a.start(555, code), 'wrong');
  t('wrong secret is ignored too', a.rows('TeacherTelegram').length === 0);
  const r = a.hook(a.start(555, code));
  t('with the secret the /start link works through doPost', r.ok === true && a.rows('TeacherTelegram').length === 1);
  const m = a.addPay(MATH); a.reset();
  a.hook(a.tap(555, 'ap', m));
  t('a teacher tap through doPost approves', a.status(m) === 'approved');
  const o = a.addPay(PROG); a.reset();
  a.hook(a.tap(Number(OWNER_CHAT), 'ap', o));
  t('the owner\'s tap through doPost still runs the existing path (unchanged)', a.status(o) === 'approved' && /Approved/.test(a.send('editMessageText')[0].body.text));
  const o2 = a.addPay(PROG); a.reset();
  a.hook(a.tap(9090, 'ap', o2));
  t('an unknown chat through doPost still does nothing', a.status(o2) === 'pending');
}

// ---- 7. unlink
{
  const a = build();
  a.link(T1, 1001, ['math']); a.link(T2, 1002, ['math']);
  a.asTeacher(T1);
  t('status: linked', (r => r.ok && r.linked === true && !!r.since)(a.ctx.p4_tg_status({})));
  t('teacher unlinks himself', a.ctx.p4_tg_unlink({}).ok === true && a.rows('TeacherTelegram').length === 1 && a.ctx.p4_tg_status({}).linked === false);
  a.reset(); const m = a.addPay(MATH);
  t('after unlinking his chat is no longer ours (tap -> false, nothing decided)', a.handle(a.tap(1001, 'ap', m)) === false && a.status(m) === 'pending');
  a.ctx._notifyAdmin('x', m);
  t('...and he gets no more pings', a.send('sendMessage', { chat_id: 1001 }).length === 0 && a.send('sendMessage', { chat_id: 1002 }).length === 1);
  a.callerCtx({ kind: 'assistant', via: 'session', id: '010', subjects: ['math'], principal: T2 });
  t('assistant cannot unlink or read status', a.ctx.p4_tg_unlink({}).error === 'Not authorized.' && a.ctx.p4_tg_status({}).error === 'Not authorized.');
  a.callerCtx({ kind: 'teacher', via: 'session', id: T1, subjects: ['math'], principal: T1 });
  t('teacher cannot call the owner unlink', a.ctx.p4_admin_tg_unlink({ phone: T2 }).error === 'Not authorized.' && a.rows('TeacherTelegram').length === 1);
  a.callerCtx({ kind: 'owner', via: 'token', id: 'owner', subjects: ['*'], principal: '' });
  t('owner unlinks a teacher by phone', a.ctx.p4_admin_tg_unlink({ phone: T2 }).ok === true && a.rows('TeacherTelegram').length === 0);
  t('owner unlink of a teacher who is not linked is still ok', a.ctx.p4_admin_tg_unlink({ phone: T1 }).ok === true);
}

// ---- 8. robustness: Telegram down, token never logged, self test
{
  const a = build();
  a.link(T1, 1001, ['math']); a.reset(); a.setFail(true);
  const m = a.addPay(MATH);
  let threw = false; try { a.ctx._notifyAdmin('x', m); a.ctx.p4_tg_notifyPayment(m); a.ctx.p4_ownerPing_('hi'); } catch (e) { threw = true; }
  t('Telegram outage never throws out of notify / ownerPing', !threw);
  t('S6 code never logs the bot token (its own log lines are scrubbed)', a.logs.filter(l => l.startsWith('p4tg:')).length > 0 && !a.logs.filter(l => l.startsWith('p4tg:')).join('\n').includes('SECRET-BOT-TOKEN'), a.logs.join('|'));
  a.setFail(false);
  t('p4_selfTest_tg passes', a.ctx.p4_selfTest_tg() === 'ALL PASS');
  const b = build({ props: { TELEGRAM_BOT_TOKEN: '' } });
  let thr = false; try { b.ctx.p4_tg_notifyPayment('x'); b.ctx.p4_ownerPing_('x'); b.handle({ update_id: 1, message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start ABCD2345' } }); } catch (e) { thr = true; }
  t('no bot token configured: everything is a quiet no-op', !thr);
  t('malformed updates return false and never throw', [null, {}, { message: null }, { callback_query: {} }, { callback_query: { data: 'ap:x' } }, 5].every(u => { try { return b.ctx.p4_tg_handleUpdate(u) === false; } catch (e) { return false; } }));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
