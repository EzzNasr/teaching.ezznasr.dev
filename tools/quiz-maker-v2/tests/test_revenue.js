// R-REV-1: Revenue.gs through the real doPost (Code.gs + Phase 4 + Revenue.gs).
// Only approved WEBSITE payments count; access given by hand never does. The lesson price is set from the page,
// written into every new lesson payment, and old lesson payments can be filled in once (option C). Owner only.
//   node tests/test_revenue.js        (run from tools/quiz-maker-v2)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeWorld, S1PHONE, S2PHONE } = require('./test_p4_s4_support');
let fails = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 600))); if (!ok) fails++; };
const J = o => JSON.stringify(o);

const W = makeWorld();
const { api, post } = W;
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Revenue.gs'), 'utf8'), api.env.ctx, { filename: 'Revenue.gs' });
api.env.setNow('2026-11-13T10:00:00Z');
const as = (who, p) => post(Object.assign({}, p, who));
const report = () => as(W.owner, { action: 'admin_revenue_report' });

// A clean Payments tab: the world's two pending rows plus hand-made history.
const pay = api.tab('Payments');
const H = ['payment_id', 'phone', 'name', 'scope', 'reference', 'note', 'status', 'created_at', 'decided_at'];
const row = (id, phone, scope, note, status, created, decided) => pay.appendRow([id, phone, 'x', scope, 'ref', note, status, created, decided || '']);
row('OLD-L1', S1PHONE, 'programming/test-course/lesson-1', 'paid by vodafone', 'approved', '2026-10-02 10:00:00', '2026-10-02 12:00:00');
row('OLD-L2', S2PHONE, 'programming/test-course/lesson-2', '', 'approved', '2026-11-03 10:00:00', '2026-11-03 11:00:00');
row('CH3', S1PHONE, 'programming/baccalaureate/grade-1-secondary#ch3', 'Grade 1 · Chapter 3 · 250 EGP', 'approved', '2026-11-01 09:00:00', '2026-11-01 10:00:00');
row('T1', S2PHONE, 'programming/baccalaureate/grade-1-secondary#t1', 'Grade 1 · Term 1 · 1000 EGP', 'approved', '2026-10-20 09:00:00', '2026-10-20 10:00:00');
row('REJ', S1PHONE, 'programming/baccalaureate/grade-1-secondary#ch4', 'Grade 1 · Chapter 4 · 250 EGP', 'rejected', '2026-11-02 09:00:00', '2026-11-02 10:00:00');
row('REV', S1PHONE, 'programming/baccalaureate/grade-1-secondary#ch5', 'Grade 1 · Chapter 5 · 250 EGP', 'revoked', '2026-11-02 09:00:00', '2026-11-02 10:00:00');
row('TYPED', S1PHONE, 'programming/baccalaureate/grade-1-secondary#ch6', '999 EGP please', 'approved', '2026-11-02 09:00:00', '2026-11-02 10:00:00');

// --- who may call it
for (const [name, who] of [['teacher', W.T], ['assistant (scoped)', W.A], ['assistant (legacy)', W.L], ['student', W.S1], ['nobody', {}]]) {
  for (const action of ['admin_revenue_report', 'admin_revenue_set_price', 'admin_revenue_fill_old']) {
    const r = as(who, { action, price: 10 });
    t(`${name} cannot call ${action}`, r.ok === false, J(r));
  }
}
t('a refused set_price changed nothing', !api.env.props.REV_LESSON_PRICE_EGP);

// --- before a lesson price is set
let r = report();
t('owner reads the report', r.ok === true && r.this_month === '2026-11' && r.last_month === '2026-10', J(r));
t('no lesson price yet', r.lesson_price === null, J(r.lesson_price));
t('this month = chapter 3 only (lesson has no amount, rejected/revoked never count)', r.totals.this_month.amount === 250 && r.totals.this_month.count === 3, J(r.totals));
t('a price typed by a student is never trusted', r.totals.all_time.amount === 1250, J(r.totals));
t('last month = the term', r.totals.last_month.amount === 1000 && r.totals.last_month.count === 2, J(r.totals));
t('pending = the world\'s two requests, no amount', r.totals.pending.count === 2 && r.totals.pending.amount === 0, J(r.totals.pending));
t('unpriced: two old lessons are fillable (+ the typed chapter, not fillable)', r.unpriced.approved === 3 && r.unpriced.fillable >= 2, J(r.unpriced));
const ch3 = r.rows.find(x => x.kind === 'chapter' && x.item === 'g1-ch3');
t('rows: chapter 3 in November, in the student\'s group', ch3 && ch3.month === '2026-11' && ch3.group === 'G-OWN' && ch3.amount === 250 && ch3.count === 1, J(r.rows));
t('rows: a term is labelled as a term', r.rows.some(x => x.kind === 'term' && x.item === 'g1-t1' && x.group === 'G-OTHER'));
t('report holds no names, phones or references', !/01000000111|01000000112|ref|vodafone|"x"/.test(J(r)), J(r).slice(0, 300));
t('fill_old refuses without a price', as(W.owner, { action: 'admin_revenue_fill_old' }).ok === false);

// --- setting the price
t('a bad price is refused', as(W.owner, { action: 'admin_revenue_set_price', price: 'abc' }).ok === false && as(W.owner, { action: 'admin_revenue_set_price', price: -5 }).ok === false);
r = as(W.owner, { action: 'admin_revenue_set_price', price: '60' });
t('owner sets the lesson price', r.ok === true && r.price === 60 && api.env.props.REV_LESSON_PRICE_EGP === '60', J(r));
t('report shows the price', report().lesson_price === 60);

// --- a new lesson payment gets the price; a manual grant adds nothing
const before = report().totals;
r = as(W.S1, { action: 'request_access', lesson: 'programming/test-course/lesson-3', reference: 'TX-1' });
t('student request_access still works', r.ok === true && r.status === 'pending', J(r));
const headers = pay.getRange(1, 1, 1, pay.getLastColumn()).getValues()[0];
const amountCol = headers.indexOf('amount') + 1;
t('an "amount" column was added to Payments', amountCol > H.length, J(headers));
const newRow = (() => { for (let i = 2; i <= pay.getLastRow(); i++) if (pay.get(i, 1) === r.payment_id) return i; return 0; })();
t('the new lesson payment carries today\'s price', newRow && Number(pay.get(newRow, amountCol)) === 60, newRow && pay.get(newRow, amountCol));
const g = as(W.owner, { action: 'admin_grant_access', phone: S2PHONE, scope: 'programming/test-course/lesson-4' });
t('owner grants access by hand (center attendance / cash)', g.ok === true, J(g));
let now = report().totals;
t('the hand grant adds no revenue and no payment', now.all_time.amount === before.all_time.amount && now.all_time.count === before.all_time.count, J([before, now]));
t('the new request shows as pending with its amount', now.pending.count === before.pending.count + 1 && now.pending.amount === 60, J(now.pending));
const ap = as(W.owner, { action: 'admin_decide_payment', payment_id: r.payment_id, decision: 'approve' });
t('approving the request still works with the extra column', ap.ok === true, J(ap));
now = report().totals;
t('...and now it counts this month', now.this_month.amount === before.this_month.amount + 60 && now.pending.amount === 0, J(now));

// --- option C: fill old lesson payments once
r = as(W.owner, { action: 'admin_revenue_fill_old', dry_run: true });
const fillable = r.fillable;
t('dry run counts the old lessons without writing', r.ok === true && fillable >= 2 && r.filled === 0, J(r));
t('...nothing written yet', report().totals.all_time.amount === now.all_time.amount);
r = as(W.owner, { action: 'admin_revenue_fill_old' });
t('fill writes them all', r.ok === true && r.filled === fillable, J(r));
const after = report();
t('old approved lessons now count (Oct lesson in last month, Nov lesson this month)', after.totals.last_month.amount === 1060 && after.totals.this_month.amount === now.this_month.amount + 60, J(after.totals));
t('subscriptions were not touched (the typed chapter stays unpriced)', after.unpriced.approved === 1 && after.unpriced.fillable === 0, J(after.unpriced));
t('running fill again changes nothing', as(W.owner, { action: 'admin_revenue_fill_old' }).filled === 0);
t('a later price change does not move filled rows', as(W.owner, { action: 'admin_revenue_set_price', price: 80 }).ok && report().totals.all_time.amount === after.totals.all_time.amount);
const l1 = after.rows.find(x => x.kind === 'lesson' && x.item === 'programming/test-course/lesson-1');
t('rows: an old lesson by month and group', l1 && l1.month === '2026-10' && l1.group === 'G-OWN' && l1.amount === 60, J(after.rows));

// --- the router without Revenue.gs
const W2 = makeWorld();
const miss = W2.post(Object.assign({ action: 'admin_revenue_report' }, W2.owner));
t('without Revenue.gs the action says "not implemented yet" (no crash)', miss.ok === false && /Not implemented yet/.test(miss.error), J(miss));
const ra = W2.post(Object.assign({ action: 'request_access', lesson: 'programming/test-course/lesson-3', reference: 'TX-2' }, W2.S1));
t('...and request_access still works without it', ra.ok === true && ra.status === 'pending', J(ra));

// --- static: the page is owner-only and the router knows the three actions
const SITE = path.join(__dirname, '..', '..', '..');
t('static: staff-guard.js lists the revenue page as owner-only', /"revenue": \["admin"\]/.test(fs.readFileSync(path.join(SITE, 'assets', 'staff-guard.js'), 'utf8')));
const code = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8');
t('static: Code.gs routes the three revenue actions', ['admin_revenue_report', 'admin_revenue_set_price', 'admin_revenue_fill_old'].every(a => code.indexOf('case "' + a + '":') >= 0));
t('static: Code.gs stamps the lesson price only through a typeof guard', /typeof rev_stampLessonPrice_ === "function"/.test(code));
const page = fs.readFileSync(path.join(SITE, 'dashboard', 'revenue.html'), 'utf8');
t('static: revenue.html never writes innerHTML', !/innerHTML\s*=/.test(page));

console.log(fails ?`\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
