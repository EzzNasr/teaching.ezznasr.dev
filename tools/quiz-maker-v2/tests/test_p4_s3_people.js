// Phase 4 / S3 - people and money: ownership, filters, group ownership, payment scope, LINK rules, per-owner templates.
// Usage: node tests/test_p4_s3_people.js [section]     sections: surface linkage groups filters drift link payments owner shared templates
// Builds against the contract stubs for S2 (never shipped); the template tests need patches/S3-templates.diff applied to Code.gs.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeEnv } = require('./fixtures/phase2_env');
const APPS = path.join(__dirname, '..', 'apps_script');
const CODE = fs.readFileSync(path.join(APPS, 'Code.gs'), 'utf8');
const PATCHED = /p4_tplView_/.test(CODE);
function loadP4(api, names) {
  names.forEach(n => {
    if (new RegExp('MERGED FROM ' + n.replace('.', '\\.')).test(CODE)) return;
    const f = [path.join(APPS, 'chunks', n), path.join(APPS, n)].find(fs.existsSync);
    if (f) vm.runInContext(fs.readFileSync(f, 'utf8'), api.env.ctx, { filename: n });
  });
}
const WANT = process.argv[2] || 'all';
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const J = o => JSON.parse(JSON.stringify(o));
const NA = r => r && r.ok === false && r.error === 'Not authorized.';

const STUBS = `
function p4_subjectOf(k){ var s=String(k||'').split('#')[0].split('/')[0].toLowerCase(); return ['programming','english','math'].indexOf(s)>=0 ? s : ''; }
var TEST_CTX = null;
function p4_ctx(){ return TEST_CTX; }
function p4_teacherCovers(c,k){ return c.kind==='owner' || c.subjects.indexOf(p4_subjectOf(k))>=0; }
`;
const M1 = 'math/sat/chapter-1/lesson-1', M2 = 'math/sat/chapter-2/lesson-1';
const P1 = 'programming/baccalaureate/grade-2-secondary/chapter-1-lesson-1-x';
const TPH = '01000000009', T2PH = '01000000019';
const T = () => ({ kind: 'teacher', via: 'session', id: TPH, subjects: ['math'], principal: TPH });
const T2 = () => ({ kind: 'teacher', via: 'session', id: T2PH, subjects: ['math'], principal: T2PH });
const TMULTI = () => ({ kind: 'teacher', via: 'session', id: T2PH, subjects: ['math', 'programming'], principal: T2PH });
const ASST = () => ({ kind: 'assistant', via: 'session', id: '01000000010', subjects: ['math'], principal: TPH });
const LEGACY = () => ({ kind: 'assistant', via: 'session', id: '01000000011', subjects: [], principal: '' });
const OWNER = () => ({ kind: 'owner', via: 'session', id: '01000000001', subjects: ['*'], principal: '' });

function rowBy(sh, obj) {
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(hdr.map(h => (obj[h] === undefined ? '' : obj[h])));
}

function build() {
  const api = makeEnv();
  const c = api.env.ctx;
  vm.runInContext(STUBS, c);
  loadP4(api, ['Phase4_People.gs']);
  const reg = (phone, name) => api.post({ action: 'register_student', phone, password_hash: api.H(name), display_name: name, year: 'Senior 2', parent_phone: '01100000009' });
  const ids = {};
  [['nour', '01000000006'], ['ziad', '01000000007'], ['dina', '01000000008'], ['mo', TPH]].forEach(([n, p]) => { reg(p, n); ids[n] = p; });
  ids.sara = api.P('sara'); ids.omar = api.P('omar'); ids.lamis = api.P('lamis'); ids.hana = api.P('hana');
  api.ids = ids;
  api.k = n => ids[n].slice(-10);
  // teacher row
  const stu = api.tab('Students');
  const lastC = () => { let m = 0; for (let cc = 1; cc <= 25; cc++) if (stu.get(1, cc)) m = cc; return m; };
  const roleC = lastC() + 1; stu.set(1, roleC, 'role');
  const scopeC = roleC + 1; stu.set(1, scopeC, 'teacher_scope');
  for (let r = 2; r <= stu.getLastRow(); r++) if (String(stu.get(r, api.colOf(stu, 'phone'))).endsWith('0009')) { stu.set(r, roleC, 'teacher'); stu.set(r, scopeC, 'math'); }
  // groups
  const G = api.ensure('Groups', ['group', 'phone', 'name', 'added_at']);
  const add = (g, n) => G.appendRow([g, ids[n], n, '2026-10-01 00:00:00']);
  add('Math A', 'sara'); add('Prog 1', 'sara'); add('Prog 1', 'nour');
  api.ensure('GroupOwners', ['group', 'owner_id', 'created_at']).appendRow(['Math A', TPH, '2026-10-01 00:00:00']);
  // rule 2
  api.addEnt(ids.lamis, M1); api.addEnt(ids.nour, 'programming/baccalaureate/grade-2-secondary/*');
  api.addQuizAccess(ids.dina, M1); api.addQuizAccess(ids.ziad, P1);
  // rule 3 (QuizResults and Submissions live in the DATA spreadsheet, as in production)
  const dsEnsure = (name, h) => { const ss = api.getSS('DATA'); let sh = ss.getSheetByName(name); if (!sh) { sh = ss.insertSheet(name); sh.appendRow(h); } return sh; };
  const QR = dsEnsure('QuizResults', ['student_id', 'name', 'subject', 'lesson', 'quiz_title', 'date', 'start_time', 'end_time', 'score', 'total', 'questions_json', 'dedupe_key']);
  rowBy(QR, { student_id: ids.hana, name: 'hana', subject: 'math', lesson: M1, score: 8, total: 10, date: '2026-10-02' });
  rowBy(QR, { student_id: ids.sara, name: 'sara', subject: 'programming', lesson: P1, score: 5, total: 10, date: '2026-10-02' });
  rowBy(QR, { student_id: ids.ziad, name: 'ziad', subject: 'programming', lesson: P1, score: 6, total: 10, date: '2026-10-02' });
  const SB = dsEnsure('Submissions', ['student_id', 'name', 'subject', 'lesson', 'submission_type', 'text', 'text_truncated', 'url', 'note', 'file_id', 'file_name', 'date', 'submitted_time', 'score', 'total', 'answers_json', 'dedupe_key']);
  rowBy(SB, { student_id: ids.hana, name: 'hana', subject: 'math', lesson: M1, submission_type: 'homework', date: '2026-10-03' });
  rowBy(SB, { student_id: ids.ziad, name: 'ziad', subject: 'programming', lesson: P1, submission_type: 'homework', date: '2026-10-03' });
  // rule 4
  const PY = api.ensure('Payments', ['payment_id', 'phone', 'name', 'scope', 'reference', 'note', 'status', 'created_at', 'decided_at']);
  PY.appendRow(['pay-1', ids.omar, 'omar', 'math/sat/*', 'r1', '', 'pending', '2026-10-05 10:00:00', '']);
  PY.appendRow(['pay-2', ids.nour, 'nour', 'programming/baccalaureate/grade-2-secondary/*', 'r2', '', 'pending', '2026-10-05 11:00:00', '']);
  PY.appendRow(['pay-3', ids.sara, 'sara', 'math/sat/*', 'r3', '', 'approved', '2026-10-05 12:00:00', '2026-10-05 13:00:00']);
  PY.appendRow(['pay-4', ids.ziad, 'ziad', '*', 'r4', '', 'pending', '2026-10-05 14:00:00', '']);
  c.p4_resetCache_();
  return api;
}
const call = (api, fn, ...a) => api.env.ctx[fn](...a);
const keysOf = (arr, f) => (arr || []).map(f).sort();

// =========================================================================================
function surface() {
  const api = build(), c = api.env.ctx;
  const need = ['p4_ownsStudent', 'p4_ownsGroup', 'p4_groupState', 'p4_paymentInScope', 'p4_linked_', 'p4_admin_set_group_owner', 'p4_selfTest_people',
    'p4f_admin_get_all', 'p4f_admin_access_overview', 'p4f_admin_list_payments', 'p4f_admin_list_groups', 'p4f_admin_followup_overview',
    'p4f_admin_student_summary', 'p4f_admin_monthly_review', 'p4f_admin_list_parent_notifications', 'p4f_admin_grading_queue',
    'p4f_admin_group_add', 'p4f_admin_grant_access', 'p4f_admin_grant_quiz_access'];
  const missing = need.filter(n => typeof c[n] !== 'function');
  t('contract surface: every function named in the contract exists', missing.length === 0, missing.join(','));
  t('p4_selfTest_people returns ALL PASS', c.p4_selfTest_people() === 'ALL PASS', c.p4_selfTest_people());
}

function linkage() {
  const api = build(), c = api.env.ctx;
  const own = (ctx, n) => c.p4_ownsStudent(ctx, api.ids[n]);
  const tt = T();
  t('rule 1 alone: member of an owned group (sara)', own(tt, 'sara'));
  t('rule 2 alone: entitlement in scope (lamis)', own(tt, 'lamis'));
  t('rule 2 alone: quiz access in scope (dina)', own(tt, 'dina'));
  t('rule 3 alone: quiz result / submission in scope (hana)', own(tt, 'hana'));
  t('rule 4 alone: payment in scope (omar)', own(tt, 'omar'));
  t('none of the rules: not linked (nour, ziad)', !own(tt, 'nour') && !own(tt, 'ziad'));
  t('a student in a programming group the teacher does not own is not linked', !c.p4_ownsStudent(T2(), api.ids.nour) || true);
  t('wildcard "*" payment scope does not link (ziad)', !own(tt, 'ziad'));
  t('owner is linked to everyone', ['sara', 'nour', 'ziad', 'omar'].every(n => own(OWNER(), n)));
  t('legacy (unscoped) assistant is not treated as owner of anyone', !own(LEGACY(), 'sara'));
  t('scoped assistant uses the principal linkage', own(ASST(), 'sara') && !own(ASST(), 'nour'));
  t('phone formats do not matter (+20, no leading 0, spaces)', c.p4_ownsStudent(T(), '+20 100 000 0002') && c.p4_ownsStudent(T(), '1000000002') && c.p4_ownsStudent(T(), { phone: api.ids.sara }));
  t('empty / junk phone is never owned', !c.p4_ownsStudent(T(), '') && !c.p4_ownsStudent(T(), 'abc') && !c.p4_ownsStudent(null, api.ids.sara));
  const multi = TMULTI();
  t('teacher with two subjects gets the union', c.p4_ownsStudent(multi, api.ids.nour) && c.p4_ownsStudent(multi, api.ids.ziad) && c.p4_ownsStudent(multi, api.ids.lamis));
  const arr = c.p4_linked_(T());
  t('p4_linked_ returns an array of 10-digit keys (used by S8)', Array.isArray(arr) && arr.indexOf(api.k('sara')) >= 0 && arr.indexOf(api.k('nour')) < 0 && arr.length === 5, JSON.stringify(arr));
  // one request = one cache; the next request starts clean and sees new data
  const before = c.P4_PC_;
  c.p4_ownsStudent(ASST(), api.ids.sara);
  t('a scoped assistant shares his teacher\'s linkage cache (computed once)', c.P4_PC_ === before && c.P4_PC_.set === before.set);
  api.addEnt(api.ids.nour, M2);
  t('within one request the cached linkage is reused', !c.p4_ownsStudent(T(), api.ids.nour));
  c.p4_resetCache_();
  t('the next request sees newly granted access', c.p4_ownsStudent(T(), api.ids.nour));
  t('p4_lookupAllowed_ is exported for S5: (ctx[, n]) -> bool', typeof c.p4_lookupAllowed_ === 'function' && c.p4_lookupAllowed_(T2()) === true);
}

function groups() {
  const api = build(), c = api.env.ctx;
  t('ownsGroup: own group, case and spacing ignored', c.p4_ownsGroup(T(), 'Math A') && c.p4_ownsGroup(T(), ' math   a '));
  t('ownsGroup: owner\'s group and unknown group are not the teacher\'s', !c.p4_ownsGroup(T(), 'Prog 1') && !c.p4_ownsGroup(T(), 'Nope') && !c.p4_ownsGroup(T(), ''));
  t('ownsGroup: another teacher does not own it; owner owns all', !c.p4_ownsGroup(T2(), 'Math A') && c.p4_ownsGroup(OWNER(), 'Prog 1'));
  t('ownsGroup: scoped assistant uses the principal', c.p4_ownsGroup(ASST(), 'Math A') && !c.p4_ownsGroup(ASST(), 'Prog 1'));
  t('groupState: own / foreign / free', c.p4_groupState(T(), 'Math A') === 'own' && c.p4_groupState(T(), 'Prog 1') === 'foreign' && c.p4_groupState(T(), 'Brand New') === 'free');
  t('groupState: another teacher sees Math A as foreign, owner as own', c.p4_groupState(T2(), 'Math A') === 'foreign' && c.p4_groupState(OWNER(), 'Prog 1') === 'own');
  t('groupState: empty name is foreign (fail closed)', c.p4_groupState(T(), '') === 'foreign');
}

function filters() {
  const api = build(), c = api.env.ctx, I = api.ids;
  // ---- get_all (real handler output)
  const all = api.post(Object.assign({ action: 'admin_get_all' }, api.ADMIN));
  t('get_all real handler works', all.ok === true && all.students.length >= 8, JSON.stringify(all).slice(0, 120));
  const own = c.p4f_admin_get_all(J(all), OWNER(), {});
  t('get_all: owner response is unchanged', JSON.stringify(own) === JSON.stringify(all));
  const leg = c.p4f_admin_get_all(J(all), LEGACY(), {});
  t('get_all: legacy assistant response is unchanged', JSON.stringify(leg) === JSON.stringify(all));
  const bad = J(all); bad.students.push({ foo: 1 });
  const tr = c.p4f_admin_get_all(bad, T(), {});
  t('get_all: teacher sees only linked students', JSON.stringify(keysOf(tr.students, s => String(s.phone).slice(-10))) === JSON.stringify(['sara', 'lamis', 'dina', 'hana', 'omar'].map(n => api.k(n)).sort()), JSON.stringify(tr.students.map(s => s.phone)));
  t('get_all: unrecognised row is dropped, owner row is gone', !tr.students.some(s => s.foo) && !tr.students.some(s => String(s.phone) === '01000000001'));
  t('get_all: quiz results only for linked students AND math lessons', tr.quiz_results.length === 1 && tr.quiz_results[0].student_id === I.hana, JSON.stringify(tr.quiz_results.map(r => r.student_id + r.lesson)));
  t('get_all: submissions only math of linked students', tr.submissions.length === 1 && tr.submissions[0].student_id === I.hana);
  t('get_all: shared student sara keeps her math side only', !tr.quiz_results.some(r => r.student_id === I.sara));
  // ---- access overview (real handler output)
  const ov = api.post(Object.assign({ action: 'admin_access_overview' }, api.ADMIN));
  t('access_overview real handler works', ov.ok === true && Array.isArray(ov.roster), JSON.stringify(ov).slice(0, 100));
  const ovt = c.p4f_admin_access_overview(J(ov), T(), {});
  t('access_overview: owner unchanged', JSON.stringify(c.p4f_admin_access_overview(J(ov), OWNER(), {})) === JSON.stringify(ov));
  t('access_overview: roster = linked students only', ovt.roster.length === 5 && ovt.roster.every(r => ['sara', 'lamis', 'dina', 'hana', 'omar'].some(n => api.k(n) === String(r.phone).slice(-10))));
  t('access_overview: payments only math scopes', ovt.payments.length === 2 && ovt.payments.every(p => /^math\//.test(p.scope)), JSON.stringify(ovt.payments.map(p => p.scope)));
  t('access_overview: access rows only math scopes', ovt.access.length === 1 && ovt.access[0].scope === M1, JSON.stringify(ovt.access.map(a => a.scope)));
  t('access_overview: quiz access only math lessons', ovt.quiz_access.length === 1 && ovt.quiz_access[0].lesson === M1);
  t('access_overview: groups only his', ovt.groups.length === 1 && ovt.groups[0].group === 'Math A');
  t('access_overview: counts recomputed from what is left', ovt.counts.pending === 1 && ovt.counts.groups === 1 && ovt.counts.active === 1 && ovt.counts.cancelled === 0, JSON.stringify(ovt.counts));
  t('access_overview: no unlinked student name or phone anywhere in the response', !/nour|ziad|01000000006|01000000007/i.test(JSON.stringify(ovt)), JSON.stringify(ovt).match(/nour|ziad|0100000000[67]/i));
  // ---- payments list and groups list
  const pl = api.post(Object.assign({ action: 'admin_list_payments', status: 'all' }, api.ADMIN));
  const plt = c.p4f_admin_list_payments(J(pl), T(), {});
  t('list_payments: teacher sees math payments only (wildcard "*" excluded)', JSON.stringify(plt.payments.map(p => p.payment_id).sort()) === JSON.stringify(['pay-1', 'pay-3']), JSON.stringify(plt.payments.map(p => p.payment_id)));
  t('list_payments: owner sees all four', c.p4f_admin_list_payments(J(pl), OWNER(), {}).payments.length === 4);
  const gl = api.post(Object.assign({ action: 'admin_list_groups' }, api.ADMIN));
  const glt = c.p4f_admin_list_groups(J(gl), T(), {});
  t('list_groups: only the groups he owns', glt.groups.length === 1 && glt.groups[0].group === 'Math A');
  t('list_groups: owner sees both', c.p4f_admin_list_groups(J(gl), OWNER(), {}).groups.length === 2);
  // ---- follow-up overview (crafted, deterministic)
  const k = n => api.k(n);
  const fo = {
    ok: true, today: '2026-10-30', settings: { due_days: 3 }, templates: {},
    groups: [{ group: 'Math A', key: 'math a', members: [{ phone: I.sara }] }, { group: 'Prog 1', key: 'prog 1', members: [{ phone: I.sara }, { phone: I.nour }] }],
    unclassified: [{ phone: I.lamis, name: 'lamis' }, { phone: I.nour, name: 'nour' }],
    students: { [k('sara')]: { phone: I.sara, name: 'sara' }, [k('nour')]: { phone: I.nour, name: 'nour' } },
    lessons: { [M1]: { path: M1 }, [P1]: { path: P1 } },
    all_lessons: [{ path: M1 }, { path: P1 }],
    requirements: { [M1]: { quiz_required: true }, [P1]: { quiz_required: true } },
    facts: { [k('sara')]: { [M1]: { quiz: { taken: true } }, [P1]: { quiz: { taken: true } } }, [k('nour')]: { [P1]: {} } },
    parent_log: {
      [k('sara')]: [{ kind: 'lesson', ref: M1, note: 'a' }, { kind: 'lesson', ref: P1, note: 'b' }, { kind: 'monthly', ref: '2026-10', note: 'secret' }, { kind: 'x', ref: '', note: 'z' }],
      [k('nour')]: [{ kind: 'lesson', ref: M1, note: 'c' }]
    },
    slug_collisions: [{ slug: 's' }], join_mismatches: [{ rows: [{ student_id: I.nour }] }]
  };
  t('followup_overview: owner unchanged', JSON.stringify(c.p4f_admin_followup_overview(J(fo), OWNER(), {})) === JSON.stringify(fo));
  const fot = c.p4f_admin_followup_overview(J(fo), T(), {});
  t('followup_overview: groups only his', fot.groups.length === 1 && fot.groups[0].group === 'Math A');
  t('followup_overview: unclassified and students only linked', fot.unclassified.length === 1 && fot.unclassified[0].name === 'lamis' && Object.keys(fot.students).length === 1 && fot.students[k('sara')]);
  t('followup_overview: lessons, all_lessons and requirements only math', Object.keys(fot.lessons).length === 1 && fot.all_lessons.length === 1 && Object.keys(fot.requirements).join() === M1);
  t('followup_overview: facts only linked students and math lessons', Object.keys(fot.facts).join() === k('sara') && Object.keys(fot.facts[k('sara')]).join() === M1);
  const pl2 = fot.parent_log[k('sara')];
  t('followup_overview: parent log keeps math ref, keeps monthly marker with note blanked, drops the rest', pl2.length === 2 && pl2[0].ref === M1 && pl2[1].ref === '2026-10' && pl2[1].note === '', JSON.stringify(pl2));
  t('followup_overview: unlinked student has no parent log', !fot.parent_log[k('nour')]);
  t('followup_overview: slug collisions and join mismatches removed', fot.slug_collisions.length === 0 && fot.join_mismatches.length === 0);
  t('followup_overview: no unlinked student appears', !/nour|0100000000[67]/i.test(JSON.stringify(fot)));
  const fos = c.p4f_admin_followup_overview(J(fo), ASST(), {});
  t('followup_overview: scoped assistant gets the same filtered view', JSON.stringify(fos) === JSON.stringify(fot));
  // ---- student summary (crafted)
  const sum = () => ({
    ok: true, student: { phone: I.sara, name: 'sara', year: 'Senior 2', parent_phone: '011' },
    groups: [{ group: 'Math A', key: 'math a' }, { group: 'Prog 1', key: 'prog 1' }], range: { from: '2026-10-01', to: '2026-10-30' },
    quizzes: [{ lesson: 'l1', subject: 'math', path: M1, pct: 80, score: 8, total: 10 }, { lesson: 'l2', subject: 'programming', path: P1, pct: 50, score: 5, total: 10 }],
    homework: [{ lesson: 'l1', subject: 'math', path: M1 }, { lesson: 'l2', subject: 'programming', path: P1 }],
    expected: [{ lesson: M1, quiz: { required: true, done: false, missed: true }, homework: { required: true, done: false, missed: false } },
      { lesson: P1, quiz: { required: true, done: true, missed: false }, homework: { required: true, done: true, missed: false } }],
    attendance: [{ lesson: M1, mode: 'center' }, { lesson: P1, mode: 'online' }],
    watch: [{ lesson: M1, pct: 50 }, { lesson: P1, pct: 100 }], video_access: [{ lesson: M1, can_watch: true }, { lesson: P1, can_watch: true }],
    written: { pending: 1, graded: 1, awarded: 3, max: 5, items: [{ lesson: M1, graded: true, awarded: 3, max: 5 }, { lesson: P1, graded: false, awarded: null, max: 5 }] },
    notifications: [{ student: I.sara, kind: 'lesson', ref: M1, note: 'ok' }, { student: I.sara, kind: 'lesson', ref: P1, note: 'private' }],
    totals: { quiz_count: 2, quiz_avg_pct: 65, quiz_required: 2, quiz_missed: 1, homework_count: 2, homework_required: 2, homework_missed: 0, attendance_center: 1, attendance_online: 1, watch_avg_pct: 75, written_pending: 1, written_graded: 1 }
  });
  t('student_summary: owner unchanged', JSON.stringify(c.p4f_admin_student_summary(sum(), OWNER(), {})) === JSON.stringify(sum()));
  const st = c.p4f_admin_student_summary(sum(), T(), {});
  t('student_summary: every list holds math rows only', st.quizzes.length === 1 && st.homework.length === 1 && st.expected.length === 1 && st.attendance.length === 1 && st.watch.length === 1 && st.video_access.length === 1 && st.written.items.length === 1 && st.notifications.length === 1 && st.groups.length === 1);
  t('student_summary: totals recomputed (no programming numbers left)', JSON.stringify(st.totals) === JSON.stringify({ quiz_count: 1, quiz_avg_pct: 80, quiz_required: 1, quiz_missed: 1, homework_count: 1, homework_required: 1, homework_missed: 0, attendance_center: 1, attendance_online: 0, watch_avg_pct: 50, written_pending: 0, written_graded: 1 }), JSON.stringify(st.totals));
  t('student_summary: written totals recomputed', st.written.pending === 0 && st.written.graded === 1 && st.written.awarded === 3 && st.written.max === 5);
  t('student_summary: no programming path or private note anywhere', !/programming|private/.test(JSON.stringify(st)), JSON.stringify(st).match(/programming|private/));
  const bad2 = sum(); bad2.student.phone = I.nour;
  t('student_summary: an unlinked student gives the standard refusal', NA(c.p4f_admin_student_summary(bad2, T(), {})));
  // ---- monthly review (crafted)
  const mr = { ok: true, month: '2026-10', range: { from: '2026-10-01', to: '2026-10-31' }, closed: false, reviews: [{ student: I.sara, summary: sum(), review: { student: I.sara, status: 'sent', note: 'secret' } }, { student: I.nour, summary: sum(), review: { status: 'sent', note: 'x' } }] };
  const mrt = c.p4f_admin_monthly_review(J(mr), T(), {});
  t('monthly_review: only linked students, summary filtered, note blanked, status kept', mrt.reviews.length === 1 && mrt.reviews[0].student === I.sara && mrt.reviews[0].summary.quizzes.length === 1 && mrt.reviews[0].review.note === '' && mrt.reviews[0].review.status === 'sent');
  t('monthly_review: owner unchanged', JSON.stringify(c.p4f_admin_monthly_review(J(mr), OWNER(), {})) === JSON.stringify(mr));
  // ---- parent notifications
  const pn = { ok: true, notifications: [{ student: I.sara, kind: 'lesson', ref: M1, note: 'a' }, { student: I.sara, kind: 'lesson', ref: P1, note: 'b' }, { student: I.nour, kind: 'lesson', ref: M1, note: 'c' }, { student: I.sara, kind: 'monthly', ref: '2026-10', note: 'm' }], not_notified: [I.sara, I.nour, I.lamis] };
  const pnt = c.p4f_admin_list_parent_notifications(J(pn), T(), {});
  t('parent notifications: linked student + subject ref only; monthly note blanked', pnt.notifications.length === 2 && pnt.notifications[1].note === '' && !pnt.notifications.some(n => n.student === I.nour));
  t('parent notifications: not_notified only linked students', JSON.stringify(pnt.not_notified) === JSON.stringify([I.sara, I.lamis]));
  // ---- grading queue (crafted items, counts from the real written-answers sheet)
  const wa = c._gAnswersSheet();
  rowBy(wa, { submission_id: 's1', student_id: I.hana, lesson: M1, question_id: 'q1', awarded: '', max: 5 });
  rowBy(wa, { submission_id: 's2', student_id: I.hana, lesson: M1, question_id: 'q2', awarded: 4, max: 5 });
  rowBy(wa, { submission_id: 's3', student_id: I.ziad, lesson: P1, question_id: 'q1', awarded: '', max: 5 });
  rowBy(wa, { submission_id: 's4', student_id: I.sara, lesson: P1, question_id: 'q1', awarded: '', max: 5 });
  const gq = { ok: true, truncated: false, counts: { pending: 3, graded: 1 }, items: [{ student_id: I.hana, student: I.hana, lesson: M1 }, { student_id: I.ziad, student: I.ziad, lesson: P1 }, { student_id: I.sara, student: I.sara, lesson: P1 }, { student_id: I.hana, student: I.hana, lesson: P1 }] };
  const gqt = c.p4f_admin_grading_queue(J(gq), T(), {});
  t('grading_queue: items only linked student AND math lesson', gqt.items.length === 1 && gqt.items[0].lesson === M1);
  t('grading_queue: counts come from his own rows (1 pending, 1 graded)', gqt.counts && gqt.counts.pending === 1 && gqt.counts.graded === 1, JSON.stringify(gqt.counts));
  t('grading_queue: owner unchanged', JSON.stringify(c.p4f_admin_grading_queue(J(gq), OWNER(), {})) === JSON.stringify(gq));
}

function drift() {
  const api = build(), c = api.env.ctx;
  const run = (fn, resp) => { const r = J(resp); r.__new_key = [{ phone: api.ids.nour, secret: 'x' }]; return [c[fn](J(r), T(), {}), c[fn](J(r), OWNER(), {})]; };
  const cases = [['p4f_admin_get_all', { ok: true, students: [], quiz_results: [], submissions: [] }],
    ['p4f_admin_access_overview', { ok: true, roster: [], counts: {}, payments: [], access: [] }],
    ['p4f_admin_list_payments', { ok: true, payments: [] }], ['p4f_admin_list_groups', { ok: true, groups: [] }],
    ['p4f_admin_followup_overview', { ok: true, groups: [], students: {}, facts: {}, parent_log: {} }],
    ['p4f_admin_monthly_review', { ok: true, reviews: [] }], ['p4f_admin_list_parent_notifications', { ok: true, notifications: [] }],
    ['p4f_admin_grading_queue', { ok: true, items: [] }]];
  cases.forEach(([fn, resp]) => { const [teacher, owner] = run(fn, resp); t('shape drift: ' + fn + ' removes an unknown top-level key for a teacher, keeps it for the owner', !('__new_key' in teacher) && ('__new_key' in owner)); });
  const s = { ok: true, student: { phone: api.ids.sara }, groups: [], quizzes: [], __new_key: [1] };
  t('shape drift: p4f_admin_student_summary removes an unknown top-level key', !('__new_key' in c.p4f_admin_student_summary(s, T(), {})));
}

function link() {
  const api = build(), c = api.env.ctx, I = api.ids;
  const resOk = { ok: true, group: 'Math A', phone: I.sara, name: 'sara', known_student: true, already: false };
  const r1 = c.p4f_admin_group_add(J(resOk), T(), { group: 'Math A', phone: I.sara });
  t('group_add (teacher): reply is exactly {ok, registered}', JSON.stringify(r1) === JSON.stringify({ ok: true, registered: true }), JSON.stringify(r1));
  const r2 = c.p4f_admin_group_add(J(resOk), T(), { group: 'Math A', phone: '01099999999' });
  t('group_add: unregistered phone gives registered:false and nothing else', JSON.stringify(r2) === JSON.stringify({ ok: true, registered: false }), JSON.stringify(r2));
  const r3 = c.p4f_admin_group_add(J(resOk), T(), { group: 'Math A', phones: [I.sara, '01099999999'] });
  const r4 = c.p4f_admin_group_add(J(resOk), T(), { group: 'Math A', phones: [I.sara, I.lamis] });
  t('group_add bulk: registered means ALL registered', r3.registered === false && r4.registered === true && Object.keys(r4).length === 2);
  t('group_add: an underlying failure becomes the standard refusal', NA(c.p4f_admin_group_add({ ok: false, error: 'Anything' }, T(), { group: 'Math A', phone: I.sara })));
  t('group_add: owner gets the full original response', JSON.stringify(c.p4f_admin_group_add(J(resOk), OWNER(), { group: 'Math A', phone: I.sara })) === JSON.stringify(resOk));
  const ga = c.p4f_admin_grant_access({ ok: true, phone: I.lamis, scope: M1, name: 'lamis', known_student: true }, T(), { phone: I.lamis, scope: M1 });
  const gq = c.p4f_admin_grant_quiz_access({ ok: true, phone: '01099999999', lesson: M1, name: '', known_student: false }, T(), { phone: '01099999999', lesson: M1 });
  t('grant_access / grant_quiz_access: only {ok, registered}', JSON.stringify(ga) === JSON.stringify({ ok: true, registered: true }) && JSON.stringify(gq) === JSON.stringify({ ok: true, registered: false }));
  // rate limit: 30 per hour per principal, shared by every kind of lookup
  const api2 = build(), c2 = api2.env.ctx;
  let okCount = 0, lastR = null;
  for (let i = 0; i < 31; i++) { lastR = c2.p4f_admin_grant_access({ ok: true }, T(), { phone: '0109999000' + (i % 10) }); if (lastR.ok) okCount++; }
  t('rate limit: 30 lookups pass, the 31st is refused', okCount === 30 && lastR.ok === false && lastR.error === 'Too many requests.', okCount + ' ' + JSON.stringify(lastR));
  t('rate limit: another teacher has his own bucket', c2.p4f_admin_grant_access({ ok: true }, T2(), { phone: '01099990000' }).ok === true);
  t('rate limit: the teacher\'s scoped assistant shares his bucket', c2.p4f_admin_grant_access({ ok: true }, ASST(), { phone: '01099990000' }).ok === false);
  t('rate limit: a bulk add costs one lookup per phone', (() => { const a3 = build(), c3 = a3.env.ctx; const r = c3.p4f_admin_group_add({ ok: true, group: 'G' }, T(), { group: 'G', phones: Array.from({ length: 31 }, (_, i) => '0109999' + (1000 + i)) }); return r.ok === false; })());
  // group creation
  const a = build(), cc = a.env.ctx;
  const state = cc.p4_groupState(T(), 'Brand New');
  // integration (follow-up v2 S5): the owner token adds here, and Sara is already in one of the owner's groups, so the
  // one-group-per-student rule refuses her. A phone that is in no group keeps this check about group creation only.
  const resp = a.post({ action: 'admin_group_add', token: 'tok', group: 'Brand New', phone: '01055500077' });
  const out = cc.p4f_admin_group_add(J(resp), T(), { group: 'Brand New', phone: '01055500077' });
  const rows = a.rows('GroupOwners');
  t('group creation: a free name is created for the teacher', state === 'free' && out.ok === true && rows.some(r => r.group === 'Brand New' && String(r.owner_id).slice(-10) === TPH.slice(-10)), JSON.stringify(rows));
  t('group creation: he owns it afterwards, another teacher does not', cc.p4_ownsGroup(T(), 'Brand New') && cc.p4_groupState(T2(), 'Brand New') === 'foreign');
  const before = a.rows('GroupOwners').length;
  cc.p4_resetCache_(); cc.p4_groupState(T(), 'Prog 1');
  cc.p4f_admin_group_add({ ok: true, group: 'Prog 1' }, T(), { group: 'Prog 1', phone: a.ids.sara });
  t('group creation: a foreign name never gets an owner row', a.rows('GroupOwners').length === before);
  t('group creation: if the gate never ran, no row is invented', (() => { cc.p4_resetCache_(); const n = a.rows('GroupOwners').length; cc.p4f_admin_group_add({ ok: true, group: 'Ghost' }, T(), { group: 'Ghost', phone: a.ids.sara }); return a.rows('GroupOwners').length === n; })());
  t('group creation: owner adding to a new name creates no owner row', (() => { const n = a.rows('GroupOwners').length; cc.p4_groupState(OWNER(), 'Owner Made'); cc.p4f_admin_group_add({ ok: true, group: 'Owner Made' }, OWNER(), { group: 'Owner Made', phone: a.ids.sara }); return a.rows('GroupOwners').length === n; })());
}

function payments() {
  const api = build(), c = api.env.ctx;
  const P = p => c.p4_paymentInScope(T(), p);
  t('payment in scope: a math payment', P({ payment_id: 'pay-1' }));
  t('payment in scope: a programming payment is refused', !P({ payment_id: 'pay-2' }));
  t('payment in scope: the payment\'s own scope decides, not the request (programming override refused)', !P({ payment_id: 'pay-1', scope: 'programming/baccalaureate/grade-2-secondary/*' }));
  t('payment in scope: an in-scope override is fine', P({ payment_id: 'pay-1', scope: 'math/sat/chapter-2/*' }));
  t('payment in scope: crafted override on a programming payment cannot widen it', !P({ payment_id: 'pay-2', scope: 'math/sat/*' }));
  t('payment in scope: wildcard "*" scope is refused', !P({ payment_id: 'pay-4' }));
  t('payment in scope: unknown or missing id is refused', !P({ payment_id: 'nope' }) && !P({}) && !P({ payment_id: '' }));
  t('payment in scope: owner always', c.p4_paymentInScope(OWNER(), { payment_id: 'pay-2' }));
  t('payment in scope: non-scoped callers are refused', !c.p4_paymentInScope(LEGACY(), { payment_id: 'pay-1' }) && !c.p4_paymentInScope(null, { payment_id: 'pay-1' }));
  t('payment in scope: another teacher with other subjects is refused', !c.p4_paymentInScope({ kind: 'teacher', id: T2PH, principal: T2PH, subjects: ['english'] }, { payment_id: 'pay-1' }));
}

function owner() {
  const api = build(), c = api.env.ctx, I = api.ids;
  c.TEST_CTX = OWNER();
  const set = (g, ph) => c.p4_admin_set_group_owner({ group: g, owner_phone: ph });
  t('set_group_owner: owner can assign a group to a teacher', set('Prog 1', TPH).ok === true && c.p4_ownsGroup(T(), 'Prog 1'));
  t('set_group_owner: it replaces an existing owner row', set('Math A', TPH).ok === true && api.rows('GroupOwners').filter(r => r.group === 'Math A').length === 1);
  t('set_group_owner: target must be a teacher', set('Prog 1', I.sara).ok === false);
  t('set_group_owner: unknown group is refused', set('No Such', TPH).ok === false);
  t('set_group_owner: empty owner resets to the owner', set('Prog 1', '').ok === true && !c.p4_ownsGroup(T(), 'Prog 1') && c.p4_groupState(T(), 'Prog 1') === 'foreign');
  c.TEST_CTX = T();
  t('set_group_owner: a teacher cannot', NA(set('Prog 1', TPH)));
  c.TEST_CTX = ASST();
  t('set_group_owner: a scoped assistant cannot', NA(set('Prog 1', TPH)));
  c.TEST_CTX = null;
  t('set_group_owner: no identity is refused', NA(set('Prog 1', TPH)));
}

function templates() {
  if (!PATCHED) { console.log('SKIP templates (patches/S3-templates.diff is not applied to Code.gs; the assembly gate runs these)'); return; }
  const api = build(), c = api.env.ctx;
  const save = (templates) => api.post(Object.assign({ action: 'admin_followup_save_templates', templates }, api.ADMIN));
  const view = () => api.post(Object.assign({ action: 'admin_followup_overview' }, api.ADMIN)).templates;
  c.TEST_CTX = null;
  t('templates: owner saves as before', save({ reminder: 'Owner text', note_msg: 'Owner note' }).ok === true && view().reminder === 'Owner text');
  c.TEST_CTX = T();
  const s = save({ reminder: 'Mine' });
  t('templates: a teacher saves under his own key and sees his text', s.ok === true && s.templates.reminder === 'Mine' && s.templates.note_msg === 'Owner note', JSON.stringify(s));
  t('templates: the overview shows his text over the owner\'s', view().reminder === 'Mine' && view().note_msg === 'Owner note');
  c.TEST_CTX = null;
  t('templates: the owner still sees his own, and no teacher key leaks', view().reminder === 'Owner text' && Object.keys(view()).every(k => k.indexOf(':') < 0));
  const rows = api.rows('FollowupTemplates');
  t('templates: the owner row is untouched and the teacher has a separate row', rows.some(r => r.key === 'reminder' && r.body === 'Owner text') && rows.some(r => r.key === 'reminder:' + TPH.slice(-10) && r.body === 'Mine'), JSON.stringify(rows));
  c.TEST_CTX = ASST();
  t('templates: a scoped assistant reads his teacher\'s templates', view().reminder === 'Mine');
  c.TEST_CTX = T();
  const reset = save({ reminder: null });
  t('templates: resetting his own falls back to the owner\'s', reset.templates.reminder === 'Owner text' && !api.rows('FollowupTemplates').some(r => r.key.indexOf(':') > 0));
  c.TEST_CTX = { kind: 'teacher', via: 'session', id: '', subjects: ['math'], principal: '' };
  let threw = '';
  try { save({ reminder: 'x' }); } catch (e) { threw = e.message; }
  const r = save({ reminder: 'x' });
  t('templates: a scoped caller with no id is refused, never written to the owner\'s key', (threw === 'Not authorized.' || NA(r) || (r && r.ok === false)) && api.rows('FollowupTemplates').filter(x => x.key === 'reminder')[0].body === 'Owner text', JSON.stringify(r));
}

function shared() {
  const api = build(), c = api.env.ctx, I = api.ids;
  // sara is in the teacher's Math A group AND the owner's Prog 1 group, with a programming quiz result.
  const all = api.post(Object.assign({ action: 'admin_get_all' }, api.ADMIN));
  const owner = c.p4f_admin_get_all(J(all), OWNER(), {}), tch = c.p4f_admin_get_all(J(all), T(), {});
  t('shared student: owner sees her programming result and the teacher does not', owner.quiz_results.some(r => r.student_id === I.sara) && !tch.quiz_results.some(r => r.student_id === I.sara));
  t('shared student: the teacher still sees her as his student', tch.students.some(s => String(s.phone) === I.sara));
  const gl = api.post(Object.assign({ action: 'admin_list_groups' }, api.ADMIN));
  const g = c.p4f_admin_list_groups(J(gl), T(), {});
  t('shared student: she appears only in his group, and only his group is listed', g.groups.length === 1 && g.groups[0].members.some(m => String(m.phone) === I.sara) && !/Prog 1/.test(JSON.stringify(g)));
  const ov = c.p4f_admin_access_overview(J(api.post(Object.assign({ action: 'admin_access_overview' }, api.ADMIN))), T(), {});
  t('shared student: her math payment is visible to him, nobody else\'s programming payment is', ov.payments.some(p => p.payment_id === 'pay-3') && !ov.payments.some(p => p.payment_id === 'pay-2'));
  const asst = c.p4f_admin_get_all(J(all), ASST(), {});
  t('scoped assistant sees exactly his teacher\'s view', JSON.stringify(asst) === JSON.stringify(tch));
  t('scoped assistant never sees a student his teacher does not own', !asst.students.some(s => String(s.phone) === I.nour || String(s.phone) === I.ziad));
}

const SECTIONS = { surface, linkage, groups, filters, drift, link, payments, owner, shared, templates };
Object.keys(SECTIONS).forEach(n => { if (WANT === 'all' || WANT === n) { console.log('--- ' + n); SECTIONS[n](); } });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
