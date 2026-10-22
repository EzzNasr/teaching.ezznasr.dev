// The Oct 18 rename incident, as a permanent regression (plan 1.1-1.2, built from the real backend).
//   R-003  a grant made under the OLD or typo'd key still unlocks the lesson under the NEW key
//   R-005  a quiz result stored under the old BARE slug counts as "taken" under the new key
//   R-006  a student with an active grant for the group's current lesson is never "can_watch:false"
// Expected to FAIL until Session 1 ships the alias resolver (see tests/registry.json: pending:S1).
// Usage: node tests/test_R003_R005_R006_rename_incident.js
const { makeEnv, LESSONS, bare } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const ONLY = process.argv[2] || '';
const t = (n, c, x) => { const id = (/^(R-\d+)/.exec(n) || [])[1]; if (ONLY && id && id !== ONLY) return; (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

for (const [name, L] of Object.entries(LESSONS)) {
  const f = makeEnv();
  f.setVideo(L.now, 'AAAAAAAAAAA', true);                       // a locked video under the NEW key
  f.group('Sat 6pm', [f.P('sara'), f.P('lamis'), f.P('hana')]);
  f.addEnt(f.P('sara'), L.old, '', 'manual');                   // grant on the OLD key (same string as new for L4)
  f.addEnt(f.P('lamis'), L.now, '', 'manual');                  // grant on the NEW key (always worked)
  f.addEnt(f.P('hana'), L.old.replace(/\/[^/]*$/, '/*'), '', 'manual');   // folder-wide scope, unaffected by renames
  f.saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: L.now, review_lessons: [] });
  f.quiz('sara', bare(L.old), 8, 'q-' + name);                  // pages posted the bare OLD slug
  const o = f.overview(), fact = who => (o.facts[f.short(who)] || {})[L.now] || {};

  t(`${name} control: a grant under the new key unlocks it`, fact('lamis').can_watch === true, JSON.stringify(fact('lamis')));
  t(`${name} control: a folder-wide scope unlocks it`, fact('hana').can_watch === true, JSON.stringify(fact('hana')));
  t(`R-003 ${name}: a grant under the old key still unlocks the lesson`, fact('sara').can_watch === true, JSON.stringify(fact('sara')));
  t(`R-006 ${name}: an entitled student never shows "video locked"`, fact('sara').can_watch !== false);
  t(`R-005 ${name}: a quiz saved under the old bare slug shows as taken`, !!(fact('sara').quiz && fact('sara').quiz.taken), JSON.stringify(fact('sara').quiz));
  t(`${name}: a student with no grant stays locked (the fix must not open everything)`, fact('omar').can_watch !== true);
}
// QuizAccess / Attendance keyed by the old string must be honoured too
{
  const L = LESSONS.L2, f = makeEnv();
  f.group('Sat 6pm', [f.P('sara')]);
  f.setVideo(L.now, 'AAAAAAAAAAA', true);
  f.post({ action: 'admin_set_quiz_lock', token: 'tok', lesson: L.now, locked: true });   // the quiz itself is gated
  f.addQuizAccess(f.P('sara'), L.old, '', 'manual');
  f.saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: L.now, review_lessons: [] });
  const o = f.overview();
  const fa = (o.facts[f.short('sara')] || {})[L.now] || {}, fo = (o.facts[f.short('omar')] || {})[L.now] || {};
  t('control: with the quiz gated, a student with no QuizAccess row sees it closed', fo.quiz_open === false, JSON.stringify(fo));
  t('R-003 QuizAccess under the old key opens the quiz under the new key', fa.quiz_open === true, JSON.stringify(fa));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
