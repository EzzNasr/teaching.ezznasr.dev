// Integration of S1 (lesson keys) + S4 (grading) + S5 (router, flags, audit). Written by S5 at
// integration. Checks the seams between the sessions, not their internals (those have their own suites):
//   - the contract-shaped migrate request/response, and ONE AuditLog header shared by every writer
//   - the router reaches every S4 action, flags gate the queue and the grade but not authoring
//   - grading and migration write audit rows (R-022 groundwork)
//   - data written under an OLD key survives migrate -> grade (the whole incident, end to end)
//   node tests/test_integration_s1_s4.js apps_script/Code.gs
const crypto = require('crypto');
const { load } = require('./harness');
const codePath = process.argv[2];
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const G2 = 'programming/baccalaureate/grade-2-secondary/';
const NEW2 = G2 + 'chapter-1-lesson-2-how-ai-works', OLD2 = G2 + 'lesson-2-how-ai-works';
const AUDIT_HEADERS = ['at', 'who', 'action', 'target', 'before', 'after'];

function world(props) {
  const env = load(codePath, { props });
  const { post, getSS } = env;
  const reg = (ph, nm) => post({ action: 'register_student', phone: ph, password_hash: H('x'), display_name: nm, year: 'Senior 2', parent_phone: '01100000009' });
  const adm = reg('01000000001', 'Teacher'), stu = reg('01000000002', 'Sara');
  const sh = getSS('STU').getSheetByName('Students');
  let ac = 0; for (let c = 1; c <= 14; c++) if (sh.get(1, c) === 'is_admin') ac = c;
  sh.set(2, ac, true);
  return { env, post, getSS, adm: { student_id: adm.student_id, session_token: adm.session_token }, stu: { student_id: stu.student_id, session_token: stu.session_token } };
}
const rows = (ss, name) => { const s = ss.getSheetByName(name); if (!s) return null; const out = []; for (let r = 1; r <= s.getLastRow(); r++) { const row = []; for (let c = 1; c <= s.getLastColumn(); c++) row.push(s.get(r, c)); out.push(row); } return out; };

// ---------------------------------------------------------------------------------------------
// Everything ON
{
  const W = world({ FF_GRADING: '1' }); const { post, getSS, adm, stu } = W; const STU = getSS('STU');

  // seed: an entitlement stored under the OLD key (the incident)
  post({ action: 'admin_grant_access', phone: '01000000002', scope: 'programming/other/x', ...adm });
  const E = STU.getSheetByName('Entitlements'); const eh = {}; for (let c = 1; c <= 10; c++) eh[E.get(1, c)] = c;
  const er = E.getLastRow() + 1; E.set(er, eh.phone, '01000000002'); E.set(er, eh.scope, OLD2); E.set(er, eh.expires_at, '');

  // 1. contract-shaped migrate: default is a dry run, and carries the contract field names
  let r = post({ action: 'admin_migrate_lesson_keys', ...adm });
  t('migrate (contract form): default is dry run', r.ok && r.dry_run === true, JSON.stringify(r));
  const ch = (r.changes || []).find(c => c.tab === 'Entitlements');
  t('migrate: change rows carry tab,row,field,before,after (contract) and from,to (S1)', ch && ch.field === 'scope' && ch.before === OLD2 && ch.after === NEW2 && ch.from === OLD2 && ch.to === NEW2, JSON.stringify(ch));
  t('migrate: dry run wrote no audit row and no backup', !(() => { const a = getSS('DATA').getSheetByName('AuditLog'); if (!a) return false; for (let i = 2; i <= a.getLastRow(); i++) if (a.get(i, 3) === 'migrate_lesson_keys') return true; return false; })() && !STU.sheets.some(s => /^bak_/.test(s.name)));
  t('migrate: dry_run:true is also a dry run', post({ action: 'admin_migrate_lesson_keys', dry_run: true, ...adm }).dry_run === true);

  // 2. apply with the contract flag
  r = post({ action: 'admin_migrate_lesson_keys', dry_run: false, ...adm });
  t('migrate: dry_run:false applies', r.ok && r.dry_run === false && (r.tabs_changed || []).includes('Entitlements'), JSON.stringify(r));
  t('migrate: backup_tab is filled (contract) and exists', !!r.backup_tab && !!STU.getSheetByName(r.backup_tab), r.backup_tab);
  t('migrate: the grant now sits on the new key', E.get(er, eh.scope) === NEW2);
  let a = rows(getSS('DATA'), 'AuditLog');
  t('audit: AuditLog has the contract header row, once', a && JSON.stringify(a[0].slice(0, 6)) === JSON.stringify(AUDIT_HEADERS), JSON.stringify(a && a[0]));
  t('audit: one migrate_lesson_keys row', a && a.filter(x => x[2] === 'migrate_lesson_keys').length === 1, JSON.stringify(a));
  r = post({ action: 'admin_migrate_lesson_keys', dry_run: false, ...adm });
  t('migrate: second apply changes nothing and adds no audit row', r.changes.length === 0 && rows(getSS('DATA'), 'AuditLog').filter(x => x[2] === 'migrate_lesson_keys').length === 1);
  t('migrate: students are refused', !post({ action: 'admin_migrate_lesson_keys', dry_run: false, ...stu }).ok);

  // 3. grading end to end on a row stored under the OLD key
  post({ action: 'admin_set_written_models', lesson: OLD2, models: [{ question_id: 'w1', max_marks: 4, model_answer: 'M', prompt: 'P' }], token: 'tok' });
  post({ action: 'upload_quiz_result', student_id: stu.student_id, lesson: 'chapter-1-lesson-2-how-ai-works', lesson_path: NEW2, subject: 'programming', quiz_title: 'Q', start_time: '2026-10-01 10:00:00', end_time: '2026-10-01 10:05:00', score: 2, total: 3, questions: [{ id: 'm1', correct: true }, { id: 'w1', type: 'written', pending: true }], client_id: 'a1' });
  const qs = getSS('DATA').getSheetByName('QuizResults'); let dk = 0; for (let c = 1; c <= 20; c++) if (qs.get(1, c) === 'dedupe_key') dk = c;
  const SID = qs.get(2, dk); t('seed: attempt row has a dedupe key', !!SID, 'dk=' + dk + ' rows=' + qs.getLastRow());
  const WA = getSS('DATA').getSheetByName('WrittenAnswers') || getSS('DATA').insertSheet('WrittenAnswers');   // S3 writes this tab at submit time
  if (!WA.getLastRow()) ['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at', 'kind', 'graded_by'].forEach((h, i) => WA.set(1, i + 1, h));
  const wh = {}; for (let c = 1; c <= WA.getLastColumn(); c++) wh[WA.get(1, c)] = c;
  Object.entries({ submission_id: SID, student_id: stu.student_id, lesson: OLD2, question_id: 'w1', drive_file_id: 'f1' }).forEach(([k, v]) => WA.set(2, wh[k], v));   // OLD key on purpose

  r = post({ action: 'admin_grading_queue', lesson: NEW2, ...adm });
  t('queue via router: finds the old-key row by the NEW key, joins the model answer', r.ok && r.items.length === 1 && r.items[0].model_answer === 'M' && r.items[0].max === 4, JSON.stringify(r));
  t('queue: contract field "student" is present next to student_id', r.items[0].student === stu.student_id && r.items[0].student_id === stu.student_id);
  t('queue with SESSION auth + student filter (grading.html shape: adminCall overwrites student_id)', post({ action: 'admin_grading_queue', student: stu.student_id, ...adm }).items.length === 1 && post({ action: 'admin_grading_queue', student: '01999999999', ...adm }).items.length === 0);
  r = post({ action: 'admin_grade_written', submission_id: SID, question_id: 'w1', student: stu.student_id, awarded: 3, note: 'ok', ...adm });
  t('grade via router: ok', r.ok && r.awarded === 3 && r.max === 4, JSON.stringify(r));
  const score = () => { const h = {}; for (let c = 1; c <= 20; c++) h[qs.get(1, c)] = c; return [qs.get(2, h.score), qs.get(2, h.total)].join('/'); };
  t('grade: attempt score = auto 2/3 + 3/4 = 5/7', score() === '5/7', score());
  post({ action: 'admin_grade_written', submission_id: SID, question_id: 'w1', awarded: 3, note: 'ok', ...adm });
  t('grade twice: unchanged', score() === '5/7', score());
  a = rows(getSS('DATA'), 'AuditLog');
  t('audit: grade_written is in the SAME tab, under the contract header', a.every(x => x.length >= 6) && JSON.stringify(a[0].slice(0, 6)) === JSON.stringify(AUDIT_HEADERS) && a.some(x => /grade_written/.test(x[2])), JSON.stringify(a.map(x => x[2])));
  t('audit: header row appears exactly once', a.filter(x => x[0] === 'at').length === 1);
  t('grade: students cannot grade, cannot read the queue', !post({ action: 'admin_grade_written', submission_id: SID, question_id: 'w1', awarded: 4, ...stu }).ok && !post({ action: 'admin_grading_queue', ...stu }).ok);

  // 4. the image route is wired and owner-only
  W.env.ctx.DriveApp.getFileById = id => ({ makeCopy() {}, getBlob: () => ({ getContentType: () => 'image/jpeg', getBytes: () => Buffer.from('IMG-' + id) }) });
  W.env.ctx.Utilities.base64Encode = b => Buffer.from(b).toString('base64');
  r = post({ action: 'get_written_image', submission_id: SID, question_id: 'w1', ...stu });
  t('get_written_image: reachable through the router; the owner gets bytes', r.ok && r.content_type === 'image/jpeg', JSON.stringify(r));
  t('get_written_image: another student is refused', !post({ action: 'get_written_image', submission_id: SID, question_id: 'w1', ...W.post({ action: 'register_student', phone: '01000000003', password_hash: H('x'), display_name: 'Omar', year: 'Senior 2', parent_phone: '01100000009' }) }).ok);
}

// ---------------------------------------------------------------------------------------------
// FF_GRADING off (the default after deploy)
{
  const W = world({}); const { post, adm } = W;
  let r = post({ action: 'admin_grading_queue', ...adm });
  t('flag off: queue answers disabled:true, not a crash', r.ok === false && r.disabled === true && /FF_GRADING/.test(r.error), JSON.stringify(r));
  r = post({ action: 'admin_grade_written', submission_id: 'x', question_id: 'y', awarded: 1, ...adm });
  t('flag off: grade answers disabled:true', r.ok === false && r.disabled === true, JSON.stringify(r));
  r = post({ action: 'admin_set_written_models', lesson: NEW2, models: [{ question_id: 'w1', max_marks: 2, model_answer: 'M', prompt: 'P' }], token: 'tok' });
  t('flag off: Quiz Maker can still save model answers (authoring is not gated)', r.ok === true, JSON.stringify(r));
  r = post({ action: 'admin_get_written_models', lesson: NEW2, token: 'tok' });
  t('flag off: ...and read them back', r.ok && r.models.length === 1, JSON.stringify(r));
  r = post({ action: 'admin_migrate_lesson_keys', ...adm });
  t('flag off: migration is not gated (dry run by default)', r.ok && r.dry_run === true, JSON.stringify(r));
}

// ---------------------------------------------------------------------------------------------
// The WrittenAnswers header contract between S3 (writer) and S4 (reader)
{
  const gsd = require('path').join(__dirname, '..', 'apps_script'), grf = require('path').join(gsd, 'Phase2_Grading.gs');
  const src = require('fs').readFileSync(require('fs').existsSync(grf) ? grf : require('path').join(gsd, 'Code.gs'), 'utf8');   // merged into Code.gs once the part is deleted
  const m = /var WA_HEADERS = (\[[^\]]*\])/.exec(src);
  const hs = m ? JSON.parse(m[1].replace(/\s+/g, ' ')) : [];
  t('WrittenAnswers headers S4 reads: student_id (not "student"); S3 must write exactly these (contract 3, v1.3)',
    JSON.stringify(hs) === JSON.stringify(['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at']), JSON.stringify(hs));
  const contract = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'docs', 'contract.md'), 'utf8');
  t('docs/contract.md section 3 documents student_id for WrittenAnswers', /`WrittenAnswers`[^\n]*`submission_id, student_id,/.test(contract));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
