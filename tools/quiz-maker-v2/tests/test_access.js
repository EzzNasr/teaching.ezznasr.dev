const { load } = require('./harness');
const crypto = require('crypto');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const has = (obj, s) => JSON.stringify(obj).includes(s);

// ---- dates, computed the same way Code.gs does (Cairo calendar day) ----
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return x.toISOString().slice(0, 10); };
const plus = n => addDays(today, n);

// ---- lessons and their videos ----
const L1 = 'programming/other/functions';
const L2 = 'programming/other/if-conditional';
const L3 = 'programming/baccalaureate/grade-2-secondary/lesson-2-how-ai-works';
const L4 = 'programming/other/functions-2';          // looks like L1 + suffix: must NOT be covered by L1
const ID = { l1: 'AAAAAAAAAAA', l1q: 'BBBBBBBBBBB', l2: 'CCCCCCCCCCC', l3: 'DDDDDDDDDDD', l4: 'EEEEEEEEEEE', x: 'FFFFFFFFFFF' };
const url = id => 'https://www.youtube.com/embed/' + id;

const env = load(path);
const { post, getSS, lockState } = env;
const stuSheet = () => getSS('STU').getSheetByName('Students');
const tab = n => getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 12; c++) if (sh.get(1, c) === name) return c; return 0; };
const rows = n => { const sh = tab(n); return sh ? Math.max(sh.getLastRow() - 1, 0) : 0; };
const cell = (n, r, name) => tab(n).get(r, colOf(tab(n), name));
const setCell = (n, r, name, v) => tab(n).set(r, colOf(tab(n), name), v);

const reg = (phone, pw, name) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 1', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const A = reg('01000000002', 'b', 'Sara');
const B = reg('01000000003', 'c', 'Omar');
const D0 = reg('01000000005', 'e', 'Layla');
stuSheet().set(2, colOf(stuSheet(), 'is_admin'), true);
const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
const ADMIN = cr(adm), SA = cr(A), SB = cr(B), SD = cr(D0);

const TOK = { token: 'tok' };
const setVideo = (lesson, slot, id) => post(Object.assign({ action: 'admin_set_video', lesson, slot, video_url: url(id) }, TOK));
[[L1, 'lesson', ID.l1], [L1, 'quiz', ID.l1q], [L2, 'lesson', ID.l2], [L3, 'lesson', ID.l3], [L4, 'lesson', ID.l4], ['english/lesson-x', 'lesson', ID.x]].forEach(a => setVideo(...a));

const get = (creds, lesson, slot = 'lesson') => post(Object.assign({ action: 'get_video', lesson, slot }, creds || {}));
const sees = (creds, lesson, slot, id) => get(creds, lesson, slot).embed_url === url(id);
const request = (creds, lesson, reference = 'ref-1', extra) => post(Object.assign({ action: 'request_access', lesson, reference }, creds, extra));
const decide = (creds, body) => post(Object.assign({ action: 'admin_decide_payment' }, creds, body));
const grant = (creds, body) => post(Object.assign({ action: 'admin_grant_access' }, creds, body));
const list = (creds, status) => post(Object.assign({ action: 'admin_list_payments' }, creds, status ? { status } : {}));

// 1. before anything is paid -----------------------------------------------------------
{
  const r = get(SA, L1);
  t('signed-in student without access: locked, need payment, no URL', r.locked && r.need === 'payment' && !has(r, ID.l1), JSON.stringify(r));
  t('no request yet, nothing expired', r.request === undefined && r.expired === undefined, JSON.stringify(r));
  t('reading never creates the Entitlements/Payments tabs', tab('Entitlements') === null && tab('Payments') === null);
}

// 2. "I paid" ----------------------------------------------------------------------------
let payA;
{
  let r = post({ action: 'request_access', lesson: L1, reference: 'x' });
  t('request needs a session', !r.ok, JSON.stringify(r));
  r = request({ student_id: SA.student_id, session_token: 'stale' }, L1);
  t('stale session is refused', !r.ok, JSON.stringify(r));
  r = request(SA, L1, '   ');
  t('a blank reference is refused', !r.ok && /reference/i.test(r.error), JSON.stringify(r));
  r = request(SA, '*');
  t('a student cannot ask for a wildcard', !r.ok, JSON.stringify(r));
  r = request(SA, 'programming/other/*');
  t('a student cannot ask for a folder wildcard', !r.ok, JSON.stringify(r));
  t('refused requests wrote nothing', tab('Payments') === null);

  r = request(SA, L1, 'wallet 01001234567 / 250 EGP', { note: 'paid this morning' });
  payA = r.payment_id;
  t('request accepted as pending', r.ok && r.status === 'pending' && /^p[0-9a-f]{8}$/.test(payA), JSON.stringify(r));
  t('one Payments row, pending, with phone + name + reference', rows('Payments') === 1 && cell('Payments', 2, 'status') === 'pending' && cell('Payments', 2, 'phone') === '01000000002' && cell('Payments', 2, 'name') === 'Sara' && /wallet/.test(cell('Payments', 2, 'reference')), JSON.stringify([cell('Payments', 2, 'status'), cell('Payments', 2, 'phone'), cell('Payments', 2, 'name')]));
  t('requesting does NOT unlock anything', !sees(SA, L1, 'lesson', ID.l1));
  t('the page can tell the request is pending', get(SA, L1).request === 'pending', JSON.stringify(get(SA, L1)));
  t('other students do not see that as their pending request', get(SB, L1).request === undefined);
  r = request(SA, L1, 'again');
  t('pressing it twice adds no second row (same id back)', r.ok && r.duplicate === true && r.payment_id === payA && rows('Payments') === 1, JSON.stringify(r));
  t('path spelled differently is the same request', request(SA, '/Programming/Other/Functions/', 'x').duplicate === true);
}

// 3. the pending-request cap ---------------------------------------------------------------
{
  const five = ['a1', 'a2', 'a3', 'a4', 'a5'].map(n => 'programming/other/' + n);
  five.forEach(l => request(SB, l, 'r'));
  t('a student can have up to 5 pending', rows('Payments') === 6, rows('Payments'));
  const r = request(SB, 'programming/other/a6', 'r');
  t('the 6th pending request is refused', !r.ok && /waiting/.test(r.error), JSON.stringify(r));
  t('the refused one wrote nothing', rows('Payments') === 6);
  t('another student is not affected by that cap', request(SD, 'programming/other/a1', 'r').ok);
  decide(ADMIN, { payment_id: list(ADMIN).payments.find(p => p.phone === '01000000005').payment_id, decision: 'reject' });
  // tidy: reject B's junk so later tests start clean
  list(ADMIN).payments.filter(p => p.phone === '01000000003').forEach(p => decide(ADMIN, { payment_id: p.payment_id, decision: 'reject' }));
}

// 4. the queue ---------------------------------------------------------------------------------
{
  let r = list(SA);
  t('a student cannot read the queue', !r.ok && !has(r, 'wallet'), JSON.stringify(r));
  r = list({});
  t('no credentials cannot read the queue', !r.ok);
  r = list(ADMIN);
  t('admin sees the pending queue', r.ok && r.payments.length === 1 && r.payments[0].payment_id === payA && r.payments[0].name === 'Sara' && r.payments[0].scope === L1 && /wallet/.test(r.payments[0].reference), JSON.stringify(r));
  r = post(Object.assign({ action: 'admin_list_payments', status: 'all' }, TOK));
  t('desktop token can list, status=all includes rejected ones', r.ok && r.payments.length === 7, JSON.stringify(r).slice(0, 200));
  t('status=all is newest first', r.payments[0].created_at >= r.payments[r.payments.length - 1].created_at);
  t('unknown status is refused', !list(ADMIN, 'maybe').ok);
}

// 5. approving ------------------------------------------------------------------------------------
{
  let r = decide(SA, { payment_id: payA, decision: 'approve', days: 30 });
  t('a student cannot approve their own payment', !r.ok && /Not authorized/.test(r.error), JSON.stringify(r));
  t('still locked after that attempt', !sees(SA, L1, 'lesson', ID.l1));
  t('bad decision word is refused', !decide(ADMIN, { payment_id: payA, decision: 'maybe' }).ok);
  t('unknown payment id is refused', !decide(ADMIN, { payment_id: 'pdeadbeef', decision: 'approve', days: 5 }).ok);
  t('bad days is refused (0, -3, 1.5, 99999, text)', [0, -3, 1.5, 99999, 'x'].every(d => !decide(ADMIN, { payment_id: payA, decision: 'approve', days: d }).ok));
  t('bad date is refused', !decide(ADMIN, { payment_id: payA, decision: 'approve', expires_at: '2026-13-45' }).ok);
  t('a still-pending request was not changed by the refusals', cell('Payments', 2, 'status') === 'pending' && tab('Entitlements') === null);

  r = decide(ADMIN, { payment_id: payA, decision: 'approve', days: 30 });
  t('admin approves for 30 days', r.ok && r.status === 'approved' && r.scope === L1 && r.expires_at === plus(30) && r.name === 'Sara', JSON.stringify(r));
  t('entitlement row written for the student', rows('Entitlements') === 1 && cell('Entitlements', 2, 'phone') === '01000000002' && cell('Entitlements', 2, 'scope') === L1 && cell('Entitlements', 2, 'expires_at') === plus(30) && /^payment:/.test(cell('Entitlements', 2, 'source')));
  t('payment row is marked approved with a time', cell('Payments', 2, 'status') === 'approved' && !!cell('Payments', 2, 'decided_at'));
  t('the student now sees the lesson video', sees(SA, L1, 'lesson', ID.l1));
  t('...and the quiz-page video of the SAME lesson', sees(SA, L1, 'quiz', ID.l1q));
  t('another student still sees nothing', !has(get(SB, L1), ID.l1) && !has(get(SB, L1, 'quiz'), ID.l1q));
  t('a logged-out visitor still sees nothing', !has(get({}, L1), ID.l1));
  t('a different lesson is still locked for her', get(SA, L2).need === 'payment' && !has(get(SA, L2), ID.l2));
  t('L1 does not cover a lesson that merely starts with the same letters', get(SA, L4).need === 'payment' && !has(get(SA, L4), ID.l4));
  t('the pending marker is gone once approved', get(SA, L2).request === undefined);
  r = decide(ADMIN, { payment_id: payA, decision: 'approve', days: 30 });
  t('approving twice is refused (no double extension)', !r.ok && /already approved/.test(r.error) && cell('Entitlements', 2, 'expires_at') === plus(30), JSON.stringify(r));
  r = decide(ADMIN, { payment_id: payA, decision: 'reject' });
  t('an approved payment cannot be flipped to rejected', !r.ok && /already approved/.test(r.error));
  r = request(SA, L1, 'again');
  t('asking again while covered says "active", adds nothing', r.ok && r.status === 'active' && rows('Payments') === 7, JSON.stringify(r));
}

// 6. rejecting ---------------------------------------------------------------------------------------
{
  const q = request(SB, L2, 'omar ref');
  let r = decide(ADMIN, { payment_id: q.payment_id, decision: 'reject' });
  t('reject works and grants nothing', r.ok && r.status === 'rejected' && !has(get(SB, L2), ID.l2) && rows('Entitlements') === 1, JSON.stringify(r));
  t('the page can tell it was rejected', get(SB, L2).request === 'rejected', JSON.stringify(get(SB, L2)));
  r = request(SB, L2, 'second try');
  t('after a rejection the student may ask again', r.ok && r.status === 'pending' && !r.duplicate, JSON.stringify(r));
  t('...and the newest request wins', get(SB, L2).request === 'pending');
  decide(ADMIN, { payment_id: r.payment_id, decision: 'reject' });
}

// 7. expiry --------------------------------------------------------------------------------------------
{
  const set = v => { setCell('Entitlements', 2, 'expires_at', v); };
  set(plus(-1));
  let r = get(SA, L1);
  t('yesterday: locked again, with the date it ended', r.locked && r.need === 'payment' && r.expired === plus(-1) && !has(r, ID.l1), JSON.stringify(r));
  set(today);
  t('today: still valid (through the end of the day)', sees(SA, L1, 'lesson', ID.l1));
  set(plus(1));
  t('tomorrow: valid', sees(SA, L1, 'lesson', ID.l1));
  set('');
  t('blank date: never expires', sees(SA, L1, 'lesson', ID.l1));
  set('soon');
  t('unreadable date: NO access (fails closed)', !has(get(SA, L1), ID.l1));
  const d = new Date(Date.UTC(+plus(2).slice(0, 4), +plus(2).slice(5, 7) - 1, +plus(2).slice(8, 10)));
  set(d);
  t('a real Date cell (Sheets converts typed dates) works', sees(SA, L1, 'lesson', ID.l1));
  const dp = new Date(Date.UTC(+plus(-2).slice(0, 4), +plus(-2).slice(5, 7) - 1, +plus(-2).slice(8, 10)));
  set(dp);
  t('a past Date cell is expired', !has(get(SA, L1), ID.l1));
  set(plus(30));
}

// 8. scopes: whole folders and everything ------------------------------------------------------------------
{
  const G = 'programming/baccalaureate/grade-2-secondary/*';
  let r = grant(ADMIN, { phone: '01000000002', scope: G, days: 10 });
  t('admin can grant a whole grade', r.ok && r.scope === G && r.expires_at === plus(10) && r.known_student === true && r.name === 'Sara', JSON.stringify(r));
  t('grade wildcard unlocks a lesson under it', sees(SA, L3, 'lesson', ID.l3));
  t('...but nothing outside it', get(SA, L2).need === 'payment');
  r = grant(ADMIN, { phone: '01000000002', scope: 'programming/other/func/*', days: 10 });
  t('folder wildcard needs a "/" boundary ("func/*" does not cover "functions-2")', r.ok && get(SA, L4).need === 'payment');
  r = grant(ADMIN, { phone: '01000000002', scope: 'programming/other/*', days: 10 });
  t('"programming/other/*" covers lessons in that folder', sees(SA, L2, 'lesson', ID.l2) && sees(SA, L4, 'lesson', ID.l4));
  r = grant(ADMIN, { phone: '01000000003', scope: '*', days: 10 });
  t('"*" unlocks everything for that student', sees(SB, L1, 'lesson', ID.l1) && sees(SB, L3, 'lesson', ID.l3) && sees(SB, L2, 'lesson', ID.l2));
  t('...and only for that student', !has(get({}, L1), ID.l1) && !has(get(SD, L1), ID.l1));
}

// 9. manual grants ---------------------------------------------------------------------------------------------------
{
  let r = grant(SA, { phone: '01000000003', scope: L2, days: 5 });
  t('a student cannot grant access', !r.ok && /Not authorized/.test(r.error), JSON.stringify(r));
  t('grant needs a full phone number', !grant(ADMIN, { phone: '0100', scope: L2, days: 5 }).ok);
  t('grant needs a valid scope', !grant(ADMIN, { phone: '01000000003', scope: '../x', days: 5 }).ok);
  const before = rows('Entitlements');
  r = grant(ADMIN, { phone: '+20 100 000 0004', scope: L1, days: 7 });
  t('a phone typed with +20 is stored as 01xxxxxxxxx, unknown student flagged', r.ok && r.phone === '01000000004' && r.known_student === false && r.name === '', JSON.stringify(r));
  t('a grant for an unregistered number still writes a row', rows('Entitlements') === before + 1 && cell('Entitlements', before + 2, 'phone') === '01000000004');
  const C = reg('1000000004', 'd', 'Nour');       // registers later, typing the number without the leading 0
  t('...and it applies once that person registers', sees(cr(C), L1, 'lesson', ID.l1), JSON.stringify(get(cr(C), L1)));
  r = grant(ADMIN, { phone: '0020 1000000002', scope: L2, expires_at: plus(20) });
  t('explicit expires_at wins over days', r.ok && r.expires_at === plus(20), JSON.stringify(r));
  const ent = tab('Entitlements'), n = ent.getLastRow() + 1;
  ent.set(n, colOf(ent, 'phone'), '1000000005');            // as Sheets stores it once the leading 0 is lost
  ent.set(n, colOf(ent, 'scope'), L2);
  ent.set(n, colOf(ent, 'expires_at'), plus(9));
  t('a hand-typed row whose phone lost its leading 0 still matches the student', sees(SD, L2, 'lesson', ID.l2), JSON.stringify(get(SD, L2)));
  t('...but only that student', !has(get(SB, L2).need === 'payment' ? {} : get(SB, L2), 'x') && get(SA, L2).ok);
}

// 10. renewals never shorten -------------------------------------------------------------------------------------------
{
  const P = { phone: '01000000002', scope: 'programming/other/renewal-test' };
  let r = grant(ADMIN, Object.assign({ days: 10 }, P));
  t('first grant: today + 10', r.expires_at === plus(10) && r.extended === false, JSON.stringify(r));
  r = grant(ADMIN, Object.assign({ days: 10 }, P));
  t('renewal counts from the current end date (not from today)', r.expires_at === plus(20) && r.extended === true, JSON.stringify(r));
  const n0 = rows('Entitlements');
  r = grant(ADMIN, Object.assign({ expires_at: plus(3) }, P));
  t('an earlier explicit date does not shorten it', r.expires_at === plus(20), JSON.stringify(r));
  r = grant(ADMIN, Object.assign({ expires_at: plus(60) }, P));
  t('a later explicit date extends it', r.expires_at === plus(60));
  t('renewing never adds a duplicate row', rows('Entitlements') === n0);
  const P2 = { phone: '01000000002', scope: 'programming/other/forever-test' };
  grant(ADMIN, Object.assign({}, P2));   // no days, no default -> never expires
  r = grant(ADMIN, Object.assign({ days: 5 }, P2));
  t('a grant with no term never expires, and a later dated grant does not cap it', r.expires_at === '', JSON.stringify(r));
}

// 11. how long an approval lasts by default ----------------------------------------------------------------------------------
{
  const q = request(SD, 'programming/other/default-days', 'r1');
  let r = decide(ADMIN, { payment_id: q.payment_id, decision: 'approve' });
  t('no term given and no default set: approval never expires', r.ok && r.expires_at === '', JSON.stringify(r));
  env.props.DEFAULT_ACCESS_DAYS = '90';
  const q2 = request(SD, 'programming/other/default-days-2', 'r2');
  r = decide(ADMIN, { payment_id: q2.payment_id, decision: 'approve' });
  t('DEFAULT_ACCESS_DAYS applies when no term is given', r.expires_at === plus(90), JSON.stringify(r));
  const q3 = request(SD, 'programming/other/default-days-3', 'r3');
  r = decide(ADMIN, { payment_id: q3.payment_id, decision: 'approve', days: 7 });
  t('an explicit term beats the default', r.expires_at === plus(7), JSON.stringify(r));
  const q4 = request(SD, 'programming/other/default-days-4', 'r4');
  r = decide(ADMIN, { payment_id: q4.payment_id, decision: 'approve', scope: 'programming/other/*', expires_at: plus(45) });
  t('the teacher can widen the scope when approving', r.ok && r.scope === 'programming/other/*' && r.expires_at === plus(45), JSON.stringify(r));
  delete env.props.DEFAULT_ACCESS_DAYS;
}

// 12. robustness ------------------------------------------------------------------------------------------------------------------------
{
  lockState.busy = true;
  let r = request(SD, 'english/busy-lesson', 'x');
  t('busy lock: "I paid" is retryable, not lost silently', !r.ok && r.retryable === true, JSON.stringify(r));
  r = decide(ADMIN, { payment_id: 'whatever', decision: 'reject' });
  t('busy lock: a decision is retryable', !r.ok && r.retryable === true, JSON.stringify(r));
  t('busy lock: students can still watch what they paid for (reads take no lock)', sees(SA, L1, 'lesson', ID.l1));
  lockState.busy = false;

  const ent = tab('Entitlements'), pc = colOf(ent, 'expires_at');
  ent.set(1, pc, 'oops');
  r = get(SA, L2);
  t('a damaged Entitlements header gives an error and NO URL', !r.ok && /Entitlements sheet is missing/.test(r.error) && !has(r, ID.l2), JSON.stringify(r));
  ent.set(1, pc, 'expires_at');
  t('fixing the header fixes it', get(SA, L1).ok);

  const pay = tab('Payments'), sc = colOf(pay, 'status');
  pay.set(1, sc, 'oops');
  r = get(SD, 'english/lesson-x');
  t('a damaged Payments header gives an error and cannot leak the URL either', !r.ok && /Payments sheet is missing/.test(r.error) && !has(r, ID.x), JSON.stringify(r));
  pay.set(1, sc, 'status');

  t('the admin preview still works for locked videos', sees(ADMIN, L1, 'lesson', ID.l1));
}

// 13. the "how to pay" text ---------------------------------------------------------------------------------
{
  const P = 'english/pay-info-test';
  setVideo(P, 'lesson', 'G'.repeat(11));
  const stranger = reg('01000000006', 'f', 'Hana');
  const SH = cr(stranger);
  let r = get(SH, P);
  t('no PAY_INSTRUCTIONS set: no pay_info key at all', r.need === 'payment' && !('pay_info' in r), JSON.stringify(r));
  env.props.PAY_INSTRUCTIONS = '  Send 200 EGP to 01012345678 (Vodafone Cash)\nthen tap "I paid".  ';
  r = get(SH, P);
  t('a signed-in student without access gets pay_info (trimmed, newline kept)', r.pay_info === 'Send 200 EGP to 01012345678 (Vodafone Cash)\nthen tap "I paid".', JSON.stringify(r));
  r = get({}, P);
  t('a logged-out visitor sees the price before signing in', r.need === 'login' && /200 EGP/.test(r.pay_info), JSON.stringify(r));
  r = get(ADMIN, P);
  t('the admin preview carries the URL and no pay_info', !!r.embed_url && !('pay_info' in r), JSON.stringify(r));
  grant(ADMIN, { phone: '01000000006', scope: P, days: 5 });
  r = get(SH, P);
  t('a paid student gets the URL and no pay_info', !!r.embed_url && !('pay_info' in r), JSON.stringify(r));
  env.props.PAY_INSTRUCTIONS = 'x'.repeat(2500);
  t('pay_info is capped at 1000 characters', get({}, P).pay_info.length === 1000);
  env.props.PAY_INSTRUCTIONS = '   \n  ';
  t('a blank PAY_INSTRUCTIONS counts as unset', !('pay_info' in get({}, P)));
  delete env.props.PAY_INSTRUCTIONS;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
