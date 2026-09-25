const { load } = require('./harness');
const crypto = require('crypto');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const has = (o, s) => JSON.stringify(o).includes(s);

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const plus = n => addDays(today, n);

const L1 = 'programming/other/functions', L2 = 'programming/other/if-conditional', L3 = 'english/grammar-basics';
const ID = { l1: 'AAAAAAAAAAA', l1q: 'BBBBBBBBBBB', l2: 'CCCCCCCCCCC', l3: 'DDDDDDDDDDD' };
const url = id => 'https://www.youtube.com/embed/' + id;

const env = load(path);
const { post, getSS, lockState } = env;
const tab = n => getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 14; c++) if (sh.get(1, c) === name) return c; return 0; };
const rows = n => { const sh = tab(n); return sh ? Math.max(sh.getLastRow() - 1, 0) : 0; };
const cell = (n, r, name) => tab(n).get(r, colOf(tab(n), name));
const setCell = (n, r, name, v) => tab(n).set(r, colOf(tab(n), name), v);
const findRow = (n, name, value) => { const sh = tab(n); for (let r = 2; r <= sh.getLastRow(); r++) if (String(sh.get(r, colOf(sh, name))) === String(value)) return r; return 0; };

const reg = (phone, pw, name) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 1', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const A = reg('01000000002', 'b', 'Sara');
const B = reg('01000000003', 'c', 'Omar');
const C = reg('01000000004', 'd', 'Nour');
const stu = getSS('STU').getSheetByName('Students');
stu.set(2, colOf(stu, 'is_admin'), true);
const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
const ADMIN = cr(adm), SA = cr(A), SB = cr(B), SC = cr(C);
const TOK = { token: 'tok' };

const setVideo = (lesson, slot, id, locked = true) => post(Object.assign({ action: 'admin_set_video', lesson, slot, video_url: url(id), locked }, TOK));
setVideo(L1, 'lesson', ID.l1); setVideo(L1, 'quiz', ID.l1q); setVideo(L2, 'lesson', ID.l2); setVideo(L3, 'lesson', ID.l3, false);

const get = (creds, lesson, slot = 'lesson') => post(Object.assign({ action: 'get_video', lesson, slot }, creds || {}));
const sees = (creds, lesson, id, slot = 'lesson') => get(creds, lesson, slot).embed_url === url(id);
const request = (creds, lesson, reference = 'ref') => post(Object.assign({ action: 'request_access', lesson, reference }, creds));
const decide = (body, creds = TOK) => post(Object.assign({ action: 'admin_decide_payment' }, creds, body));
const grant = (body, creds = TOK) => post(Object.assign({ action: 'admin_grant_access' }, creds, body));
const revoke = (body, creds = TOK) => post(Object.assign({ action: 'admin_revoke_access' }, creds, body));
const overview = (creds = TOK) => post(Object.assign({ action: 'admin_access_overview' }, creds));

// helper: student asks, teacher approves; returns the payment id
const buy = (creds, lesson, days = 30, extra) => { const q = request(creds, lesson, 'ref for ' + lesson); const d = decide(Object.assign({ payment_id: q.payment_id, decision: 'approve', days }, extra)); return { id: q.payment_id, d }; };

// 1. THE REPORTED CASE: approved -> rejected by hand in the Payments tab ---------------------------------
const payA = buy(SA, L1);
{
  t('approved student can watch (baseline)', sees(SA, L1, ID.l1) && sees(SA, L1, ID.l1q, 'quiz'));
  const row = findRow('Payments', 'payment_id', payA.id);
  const setStatus = v => setCell('Payments', row, 'status', v);
  setStatus('rejected');
  let r = get(SA, L1);
  t('hand-editing the payment to "rejected" closes the video at once', r.locked && r.need === 'payment' && !has(r, ID.l1), JSON.stringify(r));
  t('...for the quiz-page video too', !has(get(SA, L1, 'quiz'), ID.l1q));
  t('...and the page is told it was rejected', r.request === 'rejected', JSON.stringify(r));
  setStatus('approved');
  t('setting it back to "approved" opens it again', sees(SA, L1, ID.l1));
  setStatus('revoked');
  r = get(SA, L1);
  t('status "revoked" closes it and the page is told', r.need === 'payment' && r.request === 'revoked' && !has(r, ID.l1), JSON.stringify(r));
  setStatus('pending');
  t('any status but "approved" closes it (even a hand-typed "pending")', !has(get(SA, L1), ID.l1));
  setStatus(' Approved ');
  t('case and spaces do not matter: " Approved " keeps it open', sees(SA, L1, ID.l1));
  setStatus('REJECTED');
  t('"REJECTED" in capitals closes it too', !has(get(SA, L1), ID.l1));
  t('a student who has no request/access is unaffected (still open video stays open)', get(SB, L3).embed_url === url(ID.l3));
  setStatus('approved');
}

// 2. things that must NOT close access ------------------------------------------------------------------------
{
  const payB = buy(SB, L2);
  const rowB = findRow('Payments', 'payment_id', payB.id);
  tab('Payments').deleteRows(rowB, 1);
  t('deleting the Payments row does NOT take the access away', sees(SB, L2, ID.l2), JSON.stringify(get(SB, L2)));

  grant({ phone: '01000000004', scope: L2, days: 30 });
  const rowC = findRow('Entitlements', 'source', 'manual');
  t('a manual grant is recorded with source "manual"', rowC > 0);
  const pay1 = findRow('Payments', 'payment_id', payA.id);
  setCell('Payments', pay1, 'status', 'rejected');
  t("a manual grant is not affected by other people's payments", sees(SC, L2, ID.l2));
  setCell('Payments', pay1, 'status', 'approved');

  const ent = tab('Entitlements'), n = ent.getLastRow() + 1;
  ent.set(n, colOf(ent, 'phone'), '01000000004'); ent.set(n, colOf(ent, 'scope'), L1); ent.set(n, colOf(ent, 'expires_at'), plus(9)); ent.set(n, colOf(ent, 'source'), 'payment:pzzzzzzzz');
  t('an entitlement pointing at a payment id that does not exist keeps working', sees(SC, L1, ID.l1), JSON.stringify(get(SC, L1)));
  ent.set(n, colOf(ent, 'source'), 'something else typed by hand');
  t('an entitlement with any other hand-typed source works too', sees(SC, L1, ID.l1));
  tab('Entitlements').deleteRows(n, 1);
  tab('Entitlements').deleteRows(findRow('Entitlements', 'source', 'manual'), 1);
}

// 3. after a cancellation the student can start again -----------------------------------------------------------------
{
  const row = findRow('Payments', 'payment_id', payA.id);
  setCell('Payments', row, 'status', 'rejected');
  let r = request(SA, L1, 'second try');
  t('after a cancellation "I paid" makes a new pending request (not "active")', r.ok && r.status === 'pending' && !r.duplicate, JSON.stringify(r));
  t('...and the page shows it as pending', get(SA, L1).request === 'pending');
  const d = decide({ payment_id: r.payment_id, decision: 'approve', days: 10 });
  t('approving the new request works and re-opens the video', d.ok && sees(SA, L1, ID.l1), JSON.stringify(d));
  t('...on the SAME entitlement row (no duplicate), now owned by the new payment', d.extended === true && cell('Entitlements', findRow('Entitlements', 'phone', '01000000002'), 'source') === 'payment:' + r.payment_id);
  t('the old cancelled payment stays cancelled', cell('Payments', row, 'status') === 'rejected');
  t('the renewal counts from the earlier end date (30 + 10 days), never shortening it', d.expires_at === plus(40), d.expires_at);
}

// 4. admin_revoke_access --------------------------------------------------------------------------------------------------
{
  let r = revoke({ phone: '01000000002', scope: L1 }, SA);
  t('a student cannot revoke', !r.ok && /Not authorized/.test(r.error), JSON.stringify(r));
  t('no credentials cannot revoke', !revoke({ phone: '01000000002', scope: L1 }, {}).ok);
  t('revoke needs a full phone', !revoke({ phone: '0100', scope: L1 }).ok);
  t('revoke needs a valid scope', !revoke({ phone: '01000000002', scope: '../x' }).ok);
  r = revoke({ phone: '01000000002', scope: 'programming/other/never-had' });
  t('revoking something the student does not have is refused', !r.ok && /No matching access/.test(r.error), JSON.stringify(r));
  t('...and nothing was removed', sees(SA, L1, ID.l1));

  const entRows = rows('Entitlements');
  const payRow = findRow('Payments', 'payment_id', cell('Entitlements', findRow('Entitlements', 'phone', '01000000002'), 'source').replace('payment:', ''));
  r = revoke({ phone: '+20 100 000 0002', scope: L1.toUpperCase() });
  t('revoke by phone + scope (any way of typing them) removes exactly that grant', r.ok && r.removed === 1 && r.phone === '01000000002' && r.scope === L1, JSON.stringify(r));
  t('...the Entitlements row is gone', rows('Entitlements') === entRows - 1);
  t('...the student is locked out on the next load', get(SA, L1).need === 'payment' && !has(get(SA, L1), ID.l1) && !has(get(SA, L1, 'quiz'), ID.l1q));
  t('...and the payment behind it is marked "revoked" with a time', r.payments_revoked.length === 1 && cell('Payments', payRow, 'status') === 'revoked' && !!cell('Payments', payRow, 'decided_at'), JSON.stringify(r.payments_revoked));
  t('...the page is told it was revoked', get(SA, L1).request === 'revoked', JSON.stringify(get(SA, L1)));
  r = revoke({ phone: '01000000002', scope: L1 });
  t('revoking twice is refused', !r.ok);
  r = request(SA, L1, 'after revoke');
  t('a revoked student can ask again', r.ok && r.status === 'pending', JSON.stringify(r));
  decide({ payment_id: r.payment_id, decision: 'reject' });
}

// 5. revoke only touches what it should --------------------------------------------------------------------------------------------
{
  buy(SA, L1, 20);
  grant({ phone: '01000000002', scope: 'programming/other/*', days: 20 });
  grant({ phone: '01000000003', scope: L1, days: 20 });
  let r = revoke({ phone: '01000000002', scope: L1 });
  t('revoking one scope leaves the student\'s other grant (folder wildcard) working', r.ok && sees(SA, L1, ID.l1) && sees(SA, L2, ID.l2), JSON.stringify(get(SA, L1)));
  t("...and does not touch another student's grant to the same lesson", sees(SB, L1, ID.l1));
  r = revoke({ phone: '01000000002', scope: 'programming/other/*' });
  t('revoking a manual (source "manual") grant works and marks no payments', r.ok && r.removed === 1 && r.payments_revoked.length === 0, JSON.stringify(r));
  t('...now she is fully locked out', !has(get(SA, L1), ID.l1) && !has(get(SA, L2), ID.l2));

  const q = request(SC, L2, 'ref C');
  const d = decide({ payment_id: q.payment_id, decision: 'approve', days: 5 });
  r = revoke({ payment_id: q.payment_id }, ADMIN);
  t('revoke by payment id (admin session) removes what that payment granted', r.ok && r.removed === 1 && r.payments_revoked[0] === q.payment_id, JSON.stringify(r));
  t('...that student is locked', !has(get(SC, L2), ID.l2));
  r = revoke({ payment_id: q.payment_id });
  t('revoking the same payment again is refused', !r.ok);
  r = revoke({ payment_id: 'pnothere1' });
  t('an unknown payment id is refused', !r.ok);
}

// 6. cancelled rows can be cleaned up without changing history ----------------------------------------------------------------------
{
  const q = request(SC, L1, 'ref cleanup');
  decide({ payment_id: q.payment_id, decision: 'approve', days: 5 });
  setCell('Payments', findRow('Payments', 'payment_id', q.payment_id), 'status', 'rejected');
  const before = rows('Entitlements');
  const r = revoke({ phone: '01000000004', scope: L1 });
  t('a row that is already cancelled can still be removed', r.ok && rows('Entitlements') === before - 1, JSON.stringify(r));
  t('...and the payment keeps its "rejected" status (history is not rewritten)', cell('Payments', findRow('Payments', 'payment_id', q.payment_id), 'status') === 'rejected' && r.payments_revoked.length === 0);
}

// 7. busy lock ----------------------------------------------------------------------------------------------------------------------------
{
  buy(SA, L2, 5);
  lockState.busy = true;
  let r = revoke({ phone: '01000000002', scope: L2 });
  t('busy lock: revoke is retryable and changes nothing', !r.ok && r.retryable === true && sees(SA, L2, ID.l2), JSON.stringify(r));
  lockState.busy = false;
  r = revoke({ phone: '01000000002', scope: L2 });
  t('...and works once the lock is free', r.ok);
}

// 7b. extending by hand must not detach the access from its payment ---------------------------------------------------------------------
{
  const q = request(SC, L1, 'ref link');
  decide({ payment_id: q.payment_id, decision: 'approve', days: 10 });
  const row = () => findRow('Entitlements', 'source', 'payment:' + q.payment_id);
  t('approved access is tied to its payment', row() > 0);
  const g = grant({ phone: '01000000004', scope: L1, days: 10 });
  t('extending it by hand works and ends 20 days out', g.ok && g.expires_at === plus(20), JSON.stringify(g));
  t('...and the access is STILL tied to the payment (not turned into a manual grant)', row() > 0 && cell('Entitlements', row(), 'source') === 'payment:' + q.payment_id);
  setCell('Payments', findRow('Payments', 'payment_id', q.payment_id), 'status', 'rejected');
  t('so cancelling that payment afterwards still switches it off', !has(get(SC, L1), ID.l1), JSON.stringify(get(SC, L1)));
  const g2 = grant({ phone: '01000000004', scope: L1, days: 5 });
  t('a deliberate manual grant on a cancelled row switches it back on', g2.ok && sees(SC, L1, ID.l1), JSON.stringify(g2));
  t('...and the row is now a plain manual grant', cell('Entitlements', findRow('Entitlements', 'phone', '01000000004'), 'source') === 'manual' || findRow('Entitlements', 'source', 'payment:' + q.payment_id) === 0);
  setCell('Payments', findRow('Payments', 'payment_id', q.payment_id), 'status', 'approved');
  t('...so the old payment no longer controls it', sees(SC, L1, ID.l1));
  revoke({ phone: '01000000004', scope: L1 });
  // a hand-typed source is kept
  const ent = tab('Entitlements'), n = ent.getLastRow() + 1;
  ent.set(n, colOf(ent, 'phone'), '01000000004'); ent.set(n, colOf(ent, 'scope'), L2); ent.set(n, colOf(ent, 'expires_at'), plus(6)); ent.set(n, colOf(ent, 'source'), 'cash, paid in person');
  grant({ phone: '01000000004', scope: L2, days: 4 });
  t('a hand-typed source ("cash, paid in person") survives a manual extension', cell('Entitlements', n, 'source') === 'cash, paid in person', cell('Entitlements', n, 'source'));
  revoke({ phone: '01000000004', scope: L2 });
}

// 8. the overview the dashboard reads -------------------------------------------------------------------------------------------------------
{
  // a clean, known scenario on a fresh backend
  const e2 = load(path);
  const P = b => e2.post(b);
  const rg = (ph, pw, nm) => P({ action: 'register_student', phone: ph, password_hash: H(pw), display_name: nm, year: 'Senior 1', parent_phone: '01100000009' });
  const adm2 = rg('01000000001', 'a', 'Teacher'); const s1 = rg('01000000002', 'b', 'Sara'); const s2 = rg('01000000003', 'c', 'Omar');
  const st = e2.getSS('STU').getSheetByName('Students'); let ic = 0; for (let c = 1; c <= 12; c++) if (st.get(1, c) === 'is_admin') ic = c; st.set(2, ic, true);
  const OV = (extra) => P(Object.assign({ action: 'admin_access_overview' }, extra || { token: 'tok' }));
  const sv = (lesson, slot, id, locked) => P({ action: 'admin_set_video', token: 'tok', lesson, slot, video_url: url(id), locked });

  let r = OV();
  t('overview on a brand-new system: ok, empty, zero counts, nothing created', r.ok && r.payments.length === 0 && r.access.length === 0 && r.videos.length === 0 && r.counts.pending === 0 && r.counts.active === 0 && !e2.getSS('STU').getSheetByName('Payments') && !e2.getSS('STU').getSheetByName('Entitlements') && !e2.getSS('STU').getSheetByName('Videos'), JSON.stringify(r).slice(0, 200));
  t('overview reports today (Cairo)', r.today === today, r.today);
  t('a student cannot read the overview', !OV({ student_id: s1.student_id, session_token: s1.session_token }).ok);
  t('no credentials cannot read the overview', !P({ action: 'admin_access_overview' }).ok);

  sv(L1, 'lesson', ID.l1, true); sv(L1, 'quiz', ID.l1q, true); sv(L3, 'lesson', ID.l3, false);
  const ask = (s, lesson, ref) => P({ action: 'request_access', student_id: s.student_id, session_token: s.session_token, lesson, reference: ref });
  const dec = b => P(Object.assign({ action: 'admin_decide_payment', token: 'tok' }, b));
  const gr = b => P(Object.assign({ action: 'admin_grant_access', token: 'tok' }, b));

  const q1 = ask(s1, L1, 'wallet-1'); dec({ payment_id: q1.payment_id, decision: 'approve', days: 30 });   // Sara: active, 30 days
  const q2 = ask(s2, L1, 'wallet-2'); dec({ payment_id: q2.payment_id, decision: 'approve', days: 3 });    // Omar: ending soon
  const q3 = ask(s1, L2, 'wallet-3'); dec({ payment_id: q3.payment_id, decision: 'reject' });               // rejected
  const q4 = ask(s2, L2, 'wallet-4');                                                                       // pending
  gr({ phone: '01000000002', scope: 'english/*' });                                                         // Sara: never expires (manual)
  gr({ phone: '01000000003', scope: L3, expires_at: plus(-4) });                                            // Omar: expired 4 days ago
  gr({ phone: '01099999999', scope: L2, days: 10 });                                                        // a number with no account
  const q5 = ask(s1, 'programming/other/cancelled-one', 'wallet-5'); dec({ payment_id: q5.payment_id, decision: 'approve', days: 9 });
  const pr = e2.getSS('STU').getSheetByName('Payments'); let sc = 0, ic2 = 0;
  for (let c = 1; c <= 12; c++) { if (pr.get(1, c) === 'status') sc = c; if (pr.get(1, c) === 'payment_id') ic2 = c; }
  for (let rr = 2; rr <= pr.getLastRow(); rr++) if (pr.get(rr, ic2) === q5.payment_id) pr.set(rr, sc, 'rejected');  // hand-cancelled
  const en = e2.getSS('STU').getSheetByName('Entitlements'); const ne = en.getLastRow() + 1;
  let pc = 0, sco = 0, ex = 0; for (let c = 1; c <= 12; c++) { const h = en.get(1, c); if (h === 'phone') pc = c; if (h === 'scope') sco = c; if (h === 'expires_at') ex = c; }
  en.set(ne, pc, '01000000003'); en.set(ne, sco, 'programming/other/broken-date'); en.set(ne, ex, 'soon');   // unreadable date

  r = OV();
  t('overview ok after real activity', r.ok, JSON.stringify(r).slice(0, 200));
  const acc = (ph, scope) => r.access.find(a => a.phone.replace(/\D/g, '').slice(-10) === ph.slice(-10) && a.scope === scope);
  const sara = acc('1000000002', L1), omar = acc('1000000003', L1), saraE = acc('1000000002', 'english/*'), omarE = acc('1000000003', L3), ghost = acc('1099999999', L2), cancelled = acc('1000000002', 'programming/other/cancelled-one'), broken = acc('1000000003', 'programming/other/broken-date');
  t('active with a term: state, end date, days left, name joined', sara && sara.state === 'active' && sara.expires_at === plus(30) && sara.days_left === 30 && sara.name === 'Sara' && sara.known_student === true, JSON.stringify(sara));
  t('the payment behind an access row is linked', sara.payment_id === q1.payment_id && sara.payment_status === 'approved' && /^payment:/.test(sara.source), JSON.stringify(sara));
  t('a short term shows few days left', omar.state === 'active' && omar.days_left === 3, JSON.stringify(omar));
  t('a manual grant with no end date: active, never expires, no days_left', saraE.state === 'active' && saraE.expires_at === '' && saraE.days_left === null && saraE.source === 'manual' && saraE.payment_id === '', JSON.stringify(saraE));
  t('an ended term is "expired" with negative days_left', omarE.state === 'expired' && omarE.days_left === -4, JSON.stringify(omarE));
  t('a phone with no account is flagged as unknown, name empty', ghost && ghost.known_student === false && ghost.name === '' && ghost.state === 'active', JSON.stringify(ghost));
  t('a hand-cancelled payment shows as "cancelled"', cancelled && cancelled.state === 'cancelled' && cancelled.payment_status === 'rejected', JSON.stringify(cancelled));
  t('an unreadable date shows as "invalid" (gives no access)', broken && broken.state === 'invalid', JSON.stringify(broken));
  t('counts add up', r.counts.pending === 1 && r.counts.active === 4 && r.counts.ending_soon === 1 && r.counts.expired === 1 && r.counts.cancelled === 1 && r.counts.invalid === 1 && r.counts.videos_locked === 2 && r.counts.videos_open === 1, JSON.stringify(r.counts));

  const byId = id => r.payments.find(p => p.payment_id === id);
  t('payments: pending one is there with its details', byId(q4.payment_id).status === 'pending' && byId(q4.payment_id).reference === 'wallet-4' && byId(q4.payment_id).name === 'Omar' && byId(q4.payment_id).scope === L2);
  t('payments: an approved one shows what access it produced', byId(q1.payment_id).status === 'approved' && byId(q1.payment_id).access_until === plus(30) && byId(q1.payment_id).access_state === 'active', JSON.stringify(byId(q1.payment_id)));
  t('payments: a rejected one has no access', byId(q3.payment_id).status === 'rejected' && byId(q3.payment_id).access_until === undefined);
  t('payments: the hand-cancelled one says cancelled', byId(q5.payment_id).status === 'rejected' && byId(q5.payment_id).access_state === 'cancelled');
  t('payments are newest first', r.payments[0].payment_id === q5.payment_id && r.payments[r.payments.length - 1].payment_id === q1.payment_id, r.payments.map(p => p.payment_id).join());
  t('videos: every slot with its lock state', r.videos.length === 3 && r.videos.filter(v => v.locked).length === 2 && r.videos.some(v => v.lesson === L3 && v.locked === false));

  // revoke through the overview's eyes
  const rv = P({ action: 'admin_revoke_access', token: 'tok', phone: '01000000003', scope: L1 });
  r = OV();
  t('after a revoke the overview drops the row and marks the payment "revoked"', rv.ok && !r.access.find(a => a.payment_id === q2.payment_id) && r.payments.find(p => p.payment_id === q2.payment_id).status === 'revoked' && r.payments.find(p => p.payment_id === q2.payment_id).access_until === undefined);
  t('...counts follow', r.counts.active === 3 && r.counts.ending_soon === 0, JSON.stringify(r.counts));

  // an Excel-style Date cell in expires_at
  const row3 = (() => { for (let rr = 2; rr <= en.getLastRow(); rr++) if (en.get(rr, sco) === L1) return rr; return 0; })();
  const d10 = plus(10).split('-').map(Number);
  en.set(row3, ex, new Date(Date.UTC(d10[0], d10[1] - 1, d10[2])));
  r = OV();
  const saraD = r.access.find(a => a.scope === L1);
  t('a Date cell typed in the Sheet is understood', saraD && saraD.state === 'active' && saraD.expires_at === plus(10) && saraD.days_left === 10, JSON.stringify(saraD));
}

// 9. never:true --------------------------------------------------------------------------------------------------------------------------------
{
  env.props.DEFAULT_ACCESS_DAYS = '90';
  const q = request(SB, L3 + '-x', 'ref');
  let r = decide({ payment_id: q.payment_id, decision: 'approve', never: true });
  t('approve with never:true ignores DEFAULT_ACCESS_DAYS', r.ok && r.expires_at === '', JSON.stringify(r));
  r = grant({ phone: '01000000004', scope: 'programming/other/never-grant', never: true });
  t('grant with never:true never expires', r.ok && r.expires_at === '', JSON.stringify(r));
  r = grant({ phone: '01000000004', scope: 'programming/other/default-grant' });
  t('grant with no term still uses the default', r.expires_at === plus(90), JSON.stringify(r));
  delete env.props.DEFAULT_ACCESS_DAYS;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
