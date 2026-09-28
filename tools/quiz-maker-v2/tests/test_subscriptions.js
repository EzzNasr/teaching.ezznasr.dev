// Grade subscriptions (see subscription-plan.md). This file grows chunk by chunk:
// chunk 1 covers LessonTags + admin_set_lesson_tags, _normalizeScope/_scopeCovers
// "#ch"/"#t" support, and admin_decide_payment's auto scope + year-end expiry.
// Chunk 2 (sections 6-7) covers get_subscription_options / request_subscription.
// Section 4 predates them and inserts pending Payments rows by hand.
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

// ---- grade folders and some lessons under them ----
const G1 = 'programming/baccalaureate/grade-1-secondary';
const G2 = 'programming/baccalaureate/grade-2-secondary';
const G1_C1_L1 = G1 + '/chapter-1-lesson-1-intro';
const G1_C1_L2 = G1 + '/chapter-1-lesson-2-more';
const G1_C3_L1 = G1 + '/chapter-3-lesson-1-loops';
const G1_UNTAGGED = G1 + '/chapter-9-lesson-1-untagged';
const G2_C1_L1 = G2 + '/chapter-1-lesson-1-intro';
const OTHER = 'programming/other/functions';
const ID = { a: 'AAAAAAAAAAA', b: 'BBBBBBBBBBB', c: 'CCCCCCCCCCC', d: 'DDDDDDDDDDD', e: 'EEEEEEEEEEE', f: 'FFFFFFFFFFF' };
const url = id => 'https://www.youtube.com/embed/' + id;

const env = load(path, { props: { YEAR_END_G1: '2027-08-01', YEAR_END_G2: '2027-08-01' } });
const { post, getSS } = env;
const tab = n => getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 12; c++) if (sh.get(1, c) === name) return c; return 0; };
const rows = n => { const sh = tab(n); return sh ? Math.max(sh.getLastRow() - 1, 0) : 0; };
const cell = (n, r, name) => tab(n).get(r, colOf(tab(n), name));

const reg = (phone, pw, name) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 1', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const A = reg('01000000002', 'b', 'Sara');
const B = reg('01000000003', 'c', 'Omar');
const stuSheet = tab('Students');
stuSheet.set(2, colOf(stuSheet, 'is_admin'), true);
const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
const ADMIN = cr(adm), SA = cr(A), SB = cr(B);
const TOK = { token: 'tok' };

const setVideo = (lesson, slot, id) => post(Object.assign({ action: 'admin_set_video', lesson, slot, video_url: url(id) }, TOK));
[[G1_C1_L1, ID.a], [G1_C1_L2, ID.b], [G1_C3_L1, ID.c], [G1_UNTAGGED, ID.d], [G2_C1_L1, ID.e], [OTHER, ID.f]].forEach(([l, id]) => setVideo(l, 'lesson', id));

const get = (creds, lesson) => post(Object.assign({ action: 'get_video', lesson, slot: 'lesson' }, creds || {}));
const sees = (creds, lesson, id) => get(creds, lesson).embed_url === url(id);
const locked = (creds, lesson) => !!get(creds, lesson).locked;
const grant = (creds, body) => post(Object.assign({ action: 'admin_grant_access' }, creds, body));
const revoke = (creds, body) => post(Object.assign({ action: 'admin_revoke_access' }, creds, body));
const decide = (creds, body) => post(Object.assign({ action: 'admin_decide_payment' }, creds, body));
const setTag = (creds, lesson, chapter, term) => post(Object.assign({ action: 'admin_set_lesson_tags', lesson, chapter, term }, creds));

// 1. tagging -----------------------------------------------------------------------------
{
  let r = setTag(SA, G1_C1_L1, 1, 1);
  t('a student cannot set tags', !r.ok && /Not authorized/.test(r.error), JSON.stringify(r));
  t('no LessonTags tab was created by the refused attempt', tab('LessonTags') === null);

  r = setTag(ADMIN, OTHER, 1, 1);
  t('a lesson outside the two grade folders is rejected', !r.ok && /grade 1 or grade 2/.test(r.error), JSON.stringify(r));

  r = setTag(ADMIN, G1_C1_L1, 1, 1);
  t('admin tags chapter 1 / term 1', r.ok && r.chapter === 1 && r.term === 1, JSON.stringify(r));
  t('one LessonTags row written', rows('LessonTags') === 1 && cell('LessonTags', 2, 'lesson') === G1_C1_L1 && cell('LessonTags', 2, 'chapter') === 1 && cell('LessonTags', 2, 'term') === 1);

  r = setTag(ADMIN, G1_C1_L2, 1, 1);
  t('a second lesson can share the same chapter/term', r.ok, JSON.stringify(r));

  r = setTag(ADMIN, G1_C1_L2, 1, 2);
  t('retagging one lesson to a different term for the same chapter is rejected (conflicts with its sibling)', !r.ok && /already tagged term 1/.test(r.error), JSON.stringify(r));
  t('the rejected retag changed nothing', cell('LessonTags', 3, 'term') === 1);

  r = setTag(ADMIN, G1_C3_L1, 3, 1);
  t('a different chapter/term combination is fine', r.ok, JSON.stringify(r));
  r = setTag(ADMIN, G2_C1_L1, 1, 1);
  t('the same chapter number in the OTHER grade does not conflict', r.ok, JSON.stringify(r));

  r = setTag(ADMIN, G1_C1_L1, 0, 1);
  t('chapter 0 is rejected (must be 1 or more)', !r.ok, JSON.stringify(r));
  r = setTag(ADMIN, G1_C1_L1, 1.5, 1);
  t('a non-whole chapter is rejected', !r.ok, JSON.stringify(r));
  r = setTag(ADMIN, G1_C1_L1, 1, '');
  t('one field blank and the other filled is rejected', !r.ok && /both/i.test(r.error), JSON.stringify(r));
  t('none of the rejected edits changed the existing row', cell('LessonTags', 2, 'chapter') === 1 && cell('LessonTags', 2, 'term') === 1);

  r = setTag(ADMIN, G1_C1_L2, '', '');
  t('blanking both fields clears the tag', r.ok && r.chapter === '' && r.term === '', JSON.stringify(r));
  t('the cleared lesson row is gone (row count dropped by one)', rows('LessonTags') === 3);

  r = setTag(ADMIN, G1_C1_L1, 2, 1);
  t('editing an existing tag in place works and does not add a row', r.ok && r.chapter === 2, JSON.stringify(r));
  t('still 3 rows after an in-place edit', rows('LessonTags') === 3);
  setTag(ADMIN, G1_C1_L1, 1, 1);   // put it back for the sections below
  setTag(ADMIN, G1_C1_L2, 1, 1);   // retag the sibling too, for section 2
}

// 2. _normalizeScope / _scopeCovers via admin_grant_access + get_video ------------------------
{
  let r = grant(ADMIN, { phone: '01000000002', scope: G1 + '#ch1', days: 30 });
  t('a chapter scope normalizes and grants', r.ok && r.scope === G1 + '#ch1', JSON.stringify(r));
  t('it covers a lesson tagged with that chapter', sees(SA, G1_C1_L1, ID.a));
  t('...and a sibling lesson in the same chapter', sees(SA, G1_C1_L2, ID.b));
  t('it does NOT cover a different chapter', locked(SA, G1_C3_L1));
  t('it does NOT cover an untagged lesson under the same grade', locked(SA, G1_UNTAGGED));
  t('it does NOT cover the same chapter number in the other grade', locked(SA, G2_C1_L1));
  revoke(ADMIN, { phone: '01000000002', scope: G1 + '#ch1' });

  r = grant(ADMIN, { phone: '01000000003', scope: G1 + '#t1', days: 30 });
  t('a term scope normalizes and grants', r.ok && r.scope === G1 + '#t1', JSON.stringify(r));
  t('term scope covers every chapter tagged with that term', sees(SB, G1_C1_L1, ID.a) && sees(SB, G1_C3_L1, ID.c));
  t('...but not an untagged lesson', locked(SB, G1_UNTAGGED));
  t('...and not the other grade', locked(SB, G2_C1_L1));
  revoke(ADMIN, { phone: '01000000003', scope: G1 + '#t1' });

  t('malformed grade folder is rejected', !grant(ADMIN, { phone: '01000000002', scope: 'programming/other#ch1', days: 5 }).ok);
  t('malformed tag suffix is rejected', !grant(ADMIN, { phone: '01000000002', scope: G1 + '#chX', days: 5 }).ok);
  t('a "#" with nothing after it is rejected', !grant(ADMIN, { phone: '01000000002', scope: G1 + '#', days: 5 }).ok);
  t('a leading zero in the tag number is rejected, not silently reinterpreted', !grant(ADMIN, { phone: '01000000002', scope: G1 + '#ch01', days: 5 }).ok);

  // regression: legacy scope forms untouched
  r = grant(ADMIN, { phone: '01000000002', scope: OTHER, days: 5 });
  t('legacy scope: exact lesson path still works', r.ok && r.scope === OTHER && sees(SA, OTHER, ID.f), JSON.stringify(r));
  revoke(ADMIN, { phone: '01000000002', scope: OTHER });
  t('...and revoking it locks it again', locked(SA, OTHER));
  r = grant(ADMIN, { phone: '01000000002', scope: 'programming/other/*', days: 5 });
  t('legacy folder wildcard still works', r.ok && r.scope === 'programming/other/*');
  revoke(ADMIN, { phone: '01000000002', scope: 'programming/other/*' });
  r = grant(ADMIN, { phone: '01000000003', scope: '*', days: 5 });
  t('legacy "*" still works', r.ok && r.scope === '*');
  revoke(ADMIN, { phone: '01000000003', scope: '*' });
}

// 3. retagging after purchase: coverage follows current tags, not a snapshot -----------------
{
  grant(ADMIN, { phone: '01000000002', scope: G1 + '#ch1', days: 30 });
  t('holds chapter 1 before retagging (untagged lesson still locked)', locked(SA, G1_UNTAGGED) && sees(SA, G1_C1_L1, ID.a));
  setTag(ADMIN, G1_UNTAGGED, 1, 1);
  t('a lesson newly tagged into chapter 1 is covered immediately for an existing chapter-1 holder', sees(SA, G1_UNTAGGED, ID.d));
  setTag(ADMIN, G1_UNTAGGED, '', '');   // untag it again for later sections
  revoke(ADMIN, { phone: '01000000002', scope: G1 + '#ch1' });
}

// 4. approving a subscription payment: auto scope + year-end expiry, both kept -------------------
// Pending "#" rows are inserted by hand here (the purchase actions are tested in sections 6-7).
{
  const pay = (() => {
    const sheet = tab('Payments');
    if (sheet) return sheet;
    // force the Payments tab into existence the normal way (an ordinary "I paid" request)
    post({ action: 'request_access', student_id: SA.student_id, session_token: SA.session_token, lesson: OTHER, reference: 'seed' });
    decide(ADMIN, { payment_id: post(Object.assign({ action: 'admin_list_payments' }, ADMIN)).payments[0].payment_id, decision: 'reject' });
    return tab('Payments');
  })();
  const pc = name => colOf(pay, name);
  const insertPending = (phone, scope, note) => {
    const r = pay.getLastRow() + 1;
    pay.set(r, pc('payment_id'), 'psub' + r);
    pay.set(r, pc('phone'), phone);
    pay.set(r, pc('name'), 'Student');
    pay.set(r, pc('scope'), scope);
    pay.set(r, pc('reference'), 'wallet-ref');
    pay.set(r, pc('note'), note);
    pay.set(r, pc('status'), 'pending');
    pay.set(r, pc('created_at'), today + ' 00:00:00');
    pay.set(r, pc('decided_at'), '');
    return 'psub' + r;
  };

  let id = insertPending('01000000002', G1 + '#ch3', 'Grade 1 \u00b7 Chapter 3 \u00b7 250 EGP');
  let r = decide(ADMIN, { payment_id: id, decision: 'approve' });
  t('approving a chapter subscription ignores manual days and grants to year-end', r.ok && r.scope === G1 + '#ch3' && r.expires_at === '2027-08-01', JSON.stringify(r));
  t('the student now sees that chapter', sees(SA, G1_C3_L1, ID.c));

  id = insertPending('01000000002', G1 + '#t1', 'Grade 1 \u00b7 Term 1 \u00b7 1000 EGP');
  r = decide(ADMIN, { payment_id: id, decision: 'approve', days: 5, expires_at: '2026-01-01' });
  t('a manual days/expires_at override is ignored for subscription scopes too', r.ok && r.expires_at === '2027-08-01', JSON.stringify(r));
  t('both the chapter and the term entitlement are kept (both cover, neither replaces the other)', sees(SA, G1_C1_L1, ID.a) && sees(SA, G1_C3_L1, ID.c));

  env.props.YEAR_END_G2 = plus(-1);
  id = insertPending('01000000003', G2 + '#ch1', 'Grade 2 \u00b7 Chapter 1 \u00b7 250 EGP');
  r = decide(ADMIN, { payment_id: id, decision: 'approve' });
  t('approving after the grade year-end has passed is rejected', !r.ok && /year has already ended/.test(r.error), JSON.stringify(r));
  t('the rejected approval left the payment pending and granted nothing', cell('Payments', pay.getLastRow(), 'status') === 'pending' && locked(SB, G2_C1_L1));
  env.props.YEAR_END_G2 = '2027-08-01';
  r = decide(ADMIN, { payment_id: id, decision: 'approve' });
  t('fixing YEAR_END_G2 lets the same request through', r.ok && r.expires_at === '2027-08-01', JSON.stringify(r));

  delete env.props.YEAR_END_G1;
  const id2 = insertPending('01000000002', G1 + '#ch1', 'Grade 1 \u00b7 Chapter 1 \u00b7 250 EGP');
  const r2 = decide(ADMIN, { payment_id: id2, decision: 'approve' });
  t('an unset YEAR_END_Gx falls back to the shared default (2027-08-01)', r2.ok && r2.expires_at === '2027-08-01', JSON.stringify(r2));
  env.props.YEAR_END_G1 = '2027-08-01';

  r = revoke(ADMIN, { phone: '01000000002', scope: G1 + '#ch3' });
  t('revoke removes only that scope\u2019s entitlement', r.ok && r.scope === G1 + '#ch3', JSON.stringify(r));
  t('the chapter access is gone', locked(SA, G1_C3_L1));
  t('the term access (a separate row) is untouched', sees(SA, G1_C1_L1, ID.a));
}

// 5. access boundary: last day allowed, next day denied (subscription scope) -----------------
{
  grant(ADMIN, { phone: '01000000003', scope: G2 + '#ch1', expires_at: today });
  t('last allowed day: still covered', sees(SB, G2_C1_L1, ID.e));
  const ent = tab('Entitlements');
  for (let r = 2; r <= ent.getLastRow(); r++) {
    if (cell('Entitlements', r, 'phone') === '01000000003' && cell('Entitlements', r, 'scope') === G2 + '#ch1') {
      ent.set(r, colOf(ent, 'expires_at'), plus(-1));
    }
  }
  t('the day after: denied', locked(SB, G2_C1_L1));
}

// 6. get_subscription_options ---------------------------------------------------------------
const C = cr(reg('01000000004', 'd', 'Nour'));
const D = cr(reg('01000000005', 'e', 'Layla'));
const E = cr(reg('01000000006', 'f', 'Hana'));
const G1_C5_L1 = G1 + '/chapter-5-lesson-1-files';
setVideo(G1_C5_L1, 'lesson', ID.a);
setTag(ADMIN, G1_C5_L1, 5, 2);
const opts = (creds, grade) => post(Object.assign({ action: 'get_subscription_options', grade }, creds || {}));
const reqSub = (creds, body) => post(Object.assign({ action: 'request_subscription', grade: 'grade-1-secondary', reference: 'wallet 0100 / 250' }, creds, body));
const stOf = (o, n) => (o.chapters.find(c => c.chapter === n) || {}).state;
const pendingId = () => cell('Payments', tab('Payments').getLastRow(), 'payment_id');
{
  let o = opts(null, 'grade-1-secondary');
  t('public options: chapters 1, 3, 5 only (untagged lesson adds nothing)', o.ok && o.chapters.map(c => c.chapter).join() === '1,3,5', JSON.stringify(o));
  t('chapter items carry term, price 250 and lesson count', o.chapters[0].term === 1 && o.chapters[0].price === 250 && o.chapters[0].lessons === 2 && o.chapters[2].term === 2);
  t('term option is the current term (default 1), 1000 EGP, lessons counted', o.term && o.term.term === 1 && o.term.price === 1000 && o.term.lessons === 3, JSON.stringify(o.term));
  t('year_end, current_term and prices are reported', o.year_end === '2027-08-01' && o.current_term === 1 && o.prices.chapter === 250 && o.prices.term === 1000);
  t('a logged-out visitor is not signed in and sees everything "available"', o.signed_in === false && o.chapters.every(c => c.state === 'available') && o.term.state === 'available');
  t('a stale session is treated as logged out, no error', opts({ student_id: C.student_id, session_token: 'stale' }, 'grade-1-secondary').signed_in === false);
  t('grade 2 lists only its own chapter', opts(null, 'grade-2-secondary').chapters.map(c => c.chapter).join() === '1');
  t('"1", "g1" and the full folder all name grade 1', ['1', 'g1', G1].every(g => opts(null, g).grade === 'grade-1-secondary'));
  t('an unknown grade is refused', !opts(null, 'grade-3-secondary').ok && !opts(null, '').ok);
  env.props.CURRENT_TERM_G1 = '2';
  o = opts(null, 'grade-1-secondary');
  t('CURRENT_TERM_G1=2 switches the term option to term 2 (1 lesson)', o.term.term === 2 && o.term.lessons === 1 && o.chapters.length === 3, JSON.stringify(o.term));
  env.props.CURRENT_TERM_G1 = '3';
  t('a current term with no tagged lessons gives no term option', opts(null, 'grade-1-secondary').term === null);
  delete env.props.CURRENT_TERM_G1;
}

// 7. request_subscription -------------------------------------------------------------------
{
  const before = rows('Payments');
  let r = post({ action: 'request_subscription', grade: 'grade-1-secondary', item_type: 'chapter', chapter: 1, reference: 'x' });
  t('request needs a session', !r.ok, JSON.stringify(r));
  r = reqSub({ student_id: C.student_id, session_token: 'stale' }, { item_type: 'chapter', chapter: 1 });
  t('a stale session is refused', !r.ok, JSON.stringify(r));
  r = reqSub(C, { item_type: 'chapter', chapter: 1, reference: '   ' });
  t('a blank reference is refused', !r.ok && /reference/i.test(r.error), JSON.stringify(r));
  t('a bad item_type is refused', !reqSub(C, { item_type: 'booklet', chapter: 1 }).ok && !reqSub(C, { chapter: 1 }).ok);
  t('a chapter with no tagged lessons is rejected', !reqSub(C, { item_type: 'chapter', chapter: 9 }).ok && !reqSub(C, { item_type: 'chapter', chapter: 2 }).ok);
  t('a non-whole / zero chapter is rejected', !reqSub(C, { item_type: 'chapter', chapter: 1.5 }).ok && !reqSub(C, { item_type: 'chapter', chapter: 0 }).ok);
  t('an unknown grade is rejected', !reqSub(C, { grade: 'grade-3-secondary', item_type: 'chapter', chapter: 1 }).ok);
  t('a chapter that exists only in the other grade is rejected', !reqSub(C, { grade: 'grade-2-secondary', item_type: 'chapter', chapter: 3 }).ok);
  t('refused requests wrote nothing', rows('Payments') === before);

  r = reqSub(C, { item_type: 'chapter', chapter: 1, price: 1, scope: '*', note: 'free please', expires_at: '2030-01-01' });
  const p1 = r.payment_id;
  t('chapter request accepted as pending with the server-built scope, note and price', r.ok && r.status === 'pending' && r.scope === G1 + '#ch1' && r.price === 250 && r.note === 'Grade 1 \u00b7 Chapter 1 \u00b7 250 EGP', JSON.stringify(r));
  const row = tab('Payments').getLastRow();
  t('the Payments row: pending, "#" scope, server note (client price/scope/note ignored), reference kept', cell('Payments', row, 'status') === 'pending' && cell('Payments', row, 'scope') === G1 + '#ch1' && cell('Payments', row, 'note') === 'Grade 1 \u00b7 Chapter 1 \u00b7 250 EGP' && /wallet/.test(cell('Payments', row, 'reference')) && cell('Payments', row, 'phone') === '01000000004' && cell('Payments', row, 'name') === 'Nour');
  t('requesting does not unlock anything', locked(C, G1_C1_L1));
  let o = opts(C, 'grade-1-secondary');
  t('options now show it pending for that student', o.signed_in && stOf(o, 1) === 'pending' && stOf(o, 3) === 'available', JSON.stringify(o.chapters));
  t('other students do not see it as pending', stOf(opts(D, 'grade-1-secondary'), 1) === 'available');
  const n = rows('Payments');
  r = reqSub(C, { item_type: 'chapter', chapter: 1, reference: 'again' });
  t('pressing it twice adds no second row (same id back)', r.ok && r.duplicate === true && r.payment_id === p1 && rows('Payments') === n, JSON.stringify(r));

  // approval -> owned
  r = decide(ADMIN, { payment_id: p1, decision: 'approve' });
  t('admin approves it to year-end', r.ok && r.scope === G1 + '#ch1' && r.expires_at === '2027-08-01', JSON.stringify(r));
  t('the student now watches chapter 1 lessons and nothing else', sees(C, G1_C1_L1, ID.a) && sees(C, G1_C1_L2, ID.b) && locked(C, G1_C3_L1));
  t('options say owned', stOf(opts(C, 'grade-1-secondary'), 1) === 'owned');
  r = reqSub(C, { item_type: 'chapter', chapter: 1 });
  t('the same chapter cannot be bought again', !r.ok && /already own/.test(r.error) && rows('Payments') === n, JSON.stringify(r));
  r = reqSub(C, { item_type: 'chapter', chapter: 3 });
  t('several chapters can be bought (each its own purchase)', r.ok && r.scope === G1 + '#ch3', JSON.stringify(r));
  decide(ADMIN, { payment_id: r.payment_id, decision: 'approve' });
  t('...and both are then owned', stOf(opts(C, 'grade-1-secondary'), 3) === 'owned' && sees(C, G1_C3_L1, ID.c));

  // term while owning chapters: allowed, both kept
  const ents = () => { const e = tab('Entitlements'); let k = 0; for (let i = 2; i <= e.getLastRow(); i++) if (e.get(i, colOf(e, 'phone')) === '01000000004') k++; return k; };
  t('term option is still available to a student who owns chapters', opts(C, 'grade-1-secondary').term.state === 'available');
  r = reqSub(C, { item_type: 'term', term: 2 });
  t('a term other than the current one is rejected', !r.ok && /current term \(term 1\)/.test(r.error), JSON.stringify(r));
  r = reqSub(C, { item_type: 'term', term: 1, price: 5 });
  t('term purchase is allowed while owning chapters, 1000 EGP, server label', r.ok && r.scope === G1 + '#t1' && r.price === 1000 && r.note === 'Grade 1 \u00b7 Term 1 \u00b7 1000 EGP', JSON.stringify(r));
  const pt = r.payment_id;
  t('term shows pending; a second tap is idempotent', opts(C, 'grade-1-secondary').term.state === 'pending' && reqSub(C, { item_type: 'term', term: 1 }).duplicate === true);
  decide(ADMIN, { payment_id: pt, decision: 'approve' });
  t('after approval: term owned, both chapters and the term are kept', opts(C, 'grade-1-secondary').term.state === 'owned' && ents() === 3);
  t('chapters the term covers now report "owned" if bought, else covered', stOf(opts(C, 'grade-1-secondary'), 1) === 'owned');
  t('term cannot be bought twice', !reqSub(C, { item_type: 'term', term: 1 }).ok);

  // term blocks chapters of that term (only)
  r = reqSub(D, { item_type: 'term', term: 1 });
  decide(ADMIN, { payment_id: r.payment_id, decision: 'approve' });
  o = opts(D, 'grade-1-secondary');
  t('a term holder sees covered_by_term for its chapters and available for another term\u2019s', stOf(o, 1) === 'covered_by_term' && stOf(o, 3) === 'covered_by_term' && stOf(o, 5) === 'available', JSON.stringify(o.chapters));
  r = reqSub(D, { item_type: 'chapter', chapter: 3 });
  t('holding the term blocks buying a chapter of that term', !r.ok && /already covers/.test(r.error), JSON.stringify(r));
  t('...but a chapter of another term can still be bought', reqSub(D, { item_type: 'chapter', chapter: 5 }).ok);
  t('the term holder watches every term-1 lesson', sees(D, G1_C1_L1, ID.a) && sees(D, G1_C3_L1, ID.c) && locked(D, G1_C5_L1));

  // rejection, revoke, expiry all switch the state off again
  r = reqSub(E, { item_type: 'chapter', chapter: 1 });
  decide(ADMIN, { payment_id: r.payment_id, decision: 'reject' });
  t('a rejected request frees the item to be requested again', stOf(opts(E, 'grade-1-secondary'), 1) === 'available' && reqSub(E, { item_type: 'chapter', chapter: 1 }).ok);
  decide(ADMIN, { payment_id: pendingId(), decision: 'approve' });
  t('E owns chapter 1', stOf(opts(E, 'grade-1-secondary'), 1) === 'owned');
  revoke(ADMIN, { phone: '01000000006', scope: G1 + '#ch1' });
  t('revoking it makes it available (and buyable) again', stOf(opts(E, 'grade-1-secondary'), 1) === 'available' && locked(E, G1_C1_L1));
  const again = reqSub(E, { item_type: 'chapter', chapter: 1 });
  decide(ADMIN, { payment_id: again.payment_id, decision: 'approve' });
  const ent = tab('Entitlements');
  for (let i = 2; i <= ent.getLastRow(); i++) if (cell('Entitlements', i, 'phone') === '01000000006') ent.set(i, colOf(ent, 'expires_at'), plus(-1));
  t('an expired subscription no longer counts as owned', stOf(opts(E, 'grade-1-secondary'), 1) === 'available');
  const pcol = colOf(tab('Payments'), 'status');
  for (let i = 2; i <= tab('Payments').getLastRow(); i++) if (cell('Payments', i, 'phone') === '01000000006') tab('Payments').set(i, pcol, 'approved');

  // own pending cap
  for (let i = 2; i <= 22; i++) setVideo(G2 + '/cap-lesson-' + i, 'lesson', ID.b), setTag(ADMIN, G2 + '/cap-lesson-' + i, i, 2);
  const F = cr(reg('01000000007', 'g', 'Salma'));
  let okCount = 0;
  for (let i = 2; i <= 21; i++) if (reqSub(F, { grade: 'grade-2-secondary', item_type: 'chapter', chapter: i }).ok) okCount++;
  t('a student can have up to 20 pending subscription requests', okCount === 20, okCount);
  r = reqSub(F, { grade: 'grade-2-secondary', item_type: 'chapter', chapter: 22 });
  t('the 21st is refused with a "waiting" message and writes nothing', !r.ok && /waiting/.test(r.error), JSON.stringify(r));
  t('the legacy 5-request cap is untouched by this (a fresh student still gets 5 lesson requests)', (() => {
    const Z = cr(reg('01000000008', 'h', 'Zed'));
    return [1, 2, 3, 4, 5].every(i => post(Object.assign({ action: 'request_access', lesson: 'programming/other/z' + i, reference: 'r' }, Z)).ok) && !post(Object.assign({ action: 'request_access', lesson: 'programming/other/z6', reference: 'r' }, Z)).ok;
  })());

  // busy lock is retryable, not lost
  env.lockState.busy = true;
  r = reqSub(D, { item_type: 'chapter', chapter: 5 });
  t('busy lock: the request is retryable', !r.ok && r.retryable === true, JSON.stringify(r));
  t('busy lock: reading options still works (no lock)', opts(D, 'grade-1-secondary').ok);
  env.lockState.busy = false;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
