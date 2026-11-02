// Integration: Follow-up v2 (S1-S5) on top of the Phase 4 multi-teacher backend (fully wired Code.gs + P4 gate).
//   node tests/test_fu2_p4_integration.js          (run from tools/quiz-maker-v2)
// World = test_p4_s4_support.makeWorld: the owner, a math teacher "Mr Samy" (session + token), his scoped assistant,
// the owner's own (legacy) assistant, S1 in the teacher's group G-OWN, S2 in the owner's group G-OTHER.
// Checks the decisions made when the two projects were merged (Docs/INTEGRATION-REPORT.md):
//   A  who may call the new admin_fu2_* / admin_req_* actions (teacher scope = own groups, owner-only stays owner-only)
//   B  one group per student PER TEACHER (a move never takes a student out of someone else's group)
//   C  what a teacher's follow-up overview / monthly review carries (no cross-subject requirement counts)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeWorld, S1PHONE, S2PHONE } = require('./test_p4_s4_support');
const APPS = path.join(__dirname, '..', 'apps_script');
let pass = 0, fail = 0;
const t = (n, ok, d) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  -> ' + JSON.stringify(d === undefined ? '' : d).slice(0, 400))); };
const NA = r => r && r.ok === false && /Not authorized/.test(String(r.error || ''));

function world() {
  const W = makeWorld({ props: { FF_PARENT_LOG: '1', FF_MONTHLY: '1', ADMIN_TOKEN: 'tok' } });
  ['FollowupLogic.gs', 'FollowupNotify.gs', 'Requirements.gs', 'FollowupRouter.gs'].forEach(n => {
    vm.runInContext(fs.readFileSync(path.join(APPS, n), 'utf8'), W.api.env.ctx, { filename: n });
  });
  W.as = (who, payload) => W.post(Object.assign({}, W.callers[who](), payload));
  W.members = g => W.api.rows('Groups').filter(r => String(r.group).toLowerCase() === g.toLowerCase()).map(r => String(r.phone).replace(/\D/g, '').slice(-10));
  return W;
}
const k10 = p => String(p).replace(/\D/g, '').slice(-10);

// ------------------------------------------------------------------ A. who may call
{
  const W = world();
  t('world: S1 in the teacher\'s G-OWN, S2 in the owner\'s G-OTHER', W.members('G-OWN').includes(k10(S1PHONE)) && W.members('G-OTHER').includes(k10(S2PHONE)));
  const md = (who, group) => W.as(who, { action: 'admin_fu2_mark_done', group, kind: 'hw', session_date: '2026-11-07' });
  t('mark_done: owner, any group', md('owner', 'g-other').ok === true);
  t('mark_done: teacher (session), his own group', md('teacher_ses', 'g-own').ok === true, md('teacher_ses', 'g-own'));
  t('mark_done: teacher, the owner\'s group is refused', NA(md('teacher_ses', 'g-other')), md('teacher_ses', 'g-other'));
  t('mark_done: teacher, a group nobody owns yet is refused (only save/add may create)', NA(md('teacher_ses', 'g-nobody')), md('teacher_ses', 'g-nobody'));
  t('mark_done: the teacher\'s scoped assistant, his group', md('assistant_scoped', 'g-own').ok === true, md('assistant_scoped', 'g-own'));
  t('mark_done: the teacher\'s scoped assistant, the owner\'s group is refused', NA(md('assistant_scoped', 'g-other')));
  t('mark_done: the owner\'s own assistant (unscoped), the owner\'s group', md('assistant_legacy', 'g-other').ok === true, md('assistant_legacy', 'g-other'));
  t('mark_done: a student is refused', md('student', 'g-own').ok === false);
  t('mark_done: the teacher desktop token is refused (session only, like save_group)', md('teacher_tok', 'g-own').ok === false);

  const ns = who => W.as(who, { action: 'admin_fu2_notify_settings_save', group: 'g-own', hour: 18 });
  t('notify settings: owner may save', ns('owner').ok === true, ns('owner'));
  t('notify settings: the owner\'s assistant may save (P3_STAFF_ALLOW)', ns('assistant_legacy').ok === true);
  t('notify settings: teacher is refused (messages go to the owner\'s chat; no P4 row)', NA(ns('teacher_ses')));
  t('notify settings: scoped assistant is refused', NA(ns('assistant_scoped')));
  t('notify test: owner-only (even the owner\'s assistant is refused)', NA(W.as('assistant_legacy', { action: 'admin_fu2_notify_test' })));

  const rq = who => W.as(who, { action: 'admin_req_get' });
  t('requirements: owner reads', rq('owner').ok === true);
  t('requirements: the owner\'s assistant reads', rq('assistant_legacy').ok === true);
  t('requirements: teacher is refused (global policy of the owner\'s groups)', NA(rq('teacher_ses')));
  t('requirements: scoped assistant is refused', NA(rq('assistant_scoped')));
  t('requirements: teacher cannot change a global rule', NA(W.as('teacher_ses', { action: 'admin_req_save_global', key: 'watch', patch: { rule: { pct: 50 } } })));
  t('duplicates diagnostic: owner-only', W.as('owner', { action: 'admin_fu2_group_duplicates' }).ok === true && NA(W.as('teacher_ses', { action: 'admin_fu2_group_duplicates' })));
}

// ------------------------------------------------------------------ B. one group per student, per teacher
{
  const W = world();
  const add = (who, group, phone, extra) => W.as(who, Object.assign({ action: 'admin_group_add', group, phone }, extra || {}));
  // the owner's student S2 also takes Math: the teacher may add him to his own group; the owner's group keeps him
  let r = add('teacher_ses', 'G-OWN', S2PHONE);
  t('teacher adds the owner\'s student to his own group (different teacher = no conflict)', r.ok === true, r);
  t('... and S2 is still in the owner\'s G-OTHER', W.members('G-OTHER').includes(k10(S2PHONE)) && W.members('G-OWN').includes(k10(S2PHONE)));
  t('duplicates diagnostic does not report a student who is in one group per teacher', (W.as('owner', { action: 'admin_fu2_group_duplicates' }).duplicates || []).length === 0, W.as('owner', { action: 'admin_fu2_group_duplicates' }));
  // move:true from a teacher never takes a student out of someone else's group
  const W2 = world();
  r = W2.as('teacher_ses', { action: 'admin_group_add', group: 'G-OWN', phone: S2PHONE, move: true });
  t('teacher with move:true: allowed, but nothing is moved out of the owner\'s group', r.ok === true && W2.members('G-OTHER').includes(k10(S2PHONE)) && !r.moved, r);
  // the owner: same-owner groups conflict (his rule), a teacher's group does not
  r = add('owner', 'G-NEW', S2PHONE);
  t('owner: a student already in another OWNER group -> in_other_group, nothing written', r.ok === false && r.code === 'in_other_group' && r.from === 'G-OTHER' && !W.members('G-NEW').includes(k10(S2PHONE)), r);
  r = add('owner', 'G-NEW', S2PHONE, { move: true });
  t('owner with move:true moves him between his own groups', r.ok === true && W.members('G-NEW').includes(k10(S2PHONE)) && !W.members('G-OTHER').includes(k10(S2PHONE)), r);
  t('... and the teacher\'s G-OWN keeps him (other teacher)', W.members('G-OWN').includes(k10(S2PHONE)));
  r = add('owner', 'G-NEW', S1PHONE);
  t('owner adds the teacher\'s student S1 to his own group: no conflict, S1 stays in G-OWN', r.ok === true && W.members('G-OWN').includes(k10(S1PHONE)) && W.members('G-NEW').includes(k10(S1PHONE)), r);
  // the teacher's own groups follow the rule among themselves; a new name becomes his
  r = add('teacher_ses', 'G-OWN-2', S1PHONE);
  t('teacher: a student already in another of HIS groups -> in_other_group, nothing written', r.ok === false && /in_other_group/.test(r.error || '') && !W.members('G-OWN-2').includes(k10(S1PHONE)), r);
  t('... the refusal names no other teacher\'s or owner\'s group', !/G-NEW|G-OTHER/.test(JSON.stringify(r)), r);
  r = add('teacher_ses', 'G-OWN-2', S1PHONE, { move: true });
  t('teacher with move:true moves within his own groups only', r.ok === true && W.members('G-OWN-2').includes(k10(S1PHONE)) && !W.members('G-OWN').includes(k10(S1PHONE)) && W.members('G-NEW').includes(k10(S1PHONE)), r);
}

// ------------------------------------------------------------------ C. what a teacher sees
{
  const W = world();
  const ovT = W.as('teacher_ses', { action: 'admin_followup_overview' });
  t('teacher overview loads', ovT.ok !== false, ovT);
  t('teacher overview: tz_label survives the P4 key list', ovT.tz_label === 'Alex', Object.keys(ovT));
  t('teacher overview: only his group', (ovT.groups || []).map(g => g.key).join() === 'g-own', (ovT.groups || []).map(g => g.key));
  const g = (ovT.groups || [])[0] || {};
  t('teacher overview: his group carries done / notify / requirements (S2 and S4 hooks)', Array.isArray(g.done) && g.notify && g.notify.hour === 16 && g.requirements && g.requirements.homework, g);
  t('teacher overview: unclassified_requirements is there (global defaults, no student data)', !!(ovT.unclassified_requirements && ovT.unclassified_requirements.watch));
  const ovO = W.as('owner', { action: 'admin_followup_overview' });
  t('owner overview: every group', ['g-own', 'g-other'].every(k => (ovO.groups || []).some(x => x.key === k)));
  const month = String(ovO.today || '2026-11-01').slice(0, 7);
  const mT = W.as('teacher_ses', { action: 'admin_monthly_review', month, group: 'G-OWN' });
  const revs = (mT.reviews || []);
  t('teacher monthly review: his student, no cross-subject requirement counts', revs.length === 1 && revs.every(rv => rv.summary && rv.summary.requirements === undefined && rv.summary.requirements_unavailable === true), mT);
  const mO = W.as('owner', { action: 'admin_monthly_review', month, group: 'G-OTHER' });
  t('owner monthly review keeps summary.requirements', (mO.reviews || []).length === 1 && !!mO.reviews[0].summary.requirements && Array.isArray(mO.reviews[0].summary.requirements.items), mO);
  const sT = W.as('teacher_ses', { action: 'admin_student_summary', student: S1PHONE });
  t('teacher student summary: no requirements block', sT.ok !== false && sT.requirements === undefined, sT);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
