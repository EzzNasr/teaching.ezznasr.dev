// Phase 3 / Session 2: submission recovery + the send-order fix.
// Usage: node tests/test_p3_recovery.js [site root]      (default: the repo this file lives in)
//   backend  Phase3_Recovery.gs: diagnosis classifies cases A / B / C, restore is dry-run by default and idempotent,
//            back-fill is admin-only, audited and repeat-safe.
//   client   assign.js / quiz.js (live + template copies): the submission is posted BEFORE any photo, a refused photo never
//            blocks it, and queued records are re-sent for the right student only.
const fs = require('fs'), path = require('path'), vm = require('vm');
const SITE = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const QM = path.join(SITE, 'tools', 'quiz-maker-v2');
const { makeEnv, G2 } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

(async () => {
  // ======================= backend =======================
  const f = makeEnv();
  const ctx = f.env.ctx;
  vm.runInContext(read(path.join(QM, 'apps_script', 'Phase3_Recovery.gs')), ctx, { filename: 'Phase3_Recovery.gs' });
  f.env.setNow('2026-10-27T12:00:00Z');
  const LA = G2 + 'chapter-2-lesson-1-cryptography', LB = G2 + 'chapter-2-lesson-2-network-security';
  const slugA = LA.split('/').pop();
  const DATA = f.getSS('DATA');
  const dataRows = name => { const sh = DATA.getSheetByName(name); if (!sh) return []; const o = []; for (let r = 2; r <= sh.getLastRow(); r++) { const row = {}; for (let c = 1; c <= 30; c++) if (sh.get(1, c)) row[sh.get(1, c)] = sh.get(r, c); o.push(row); } return o; };

  f.group('Sat 6pm', [f.P('sara'), f.P('omar'), f.P('lamis'), f.P('hana')]);
  const sg = f.saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: LA, hw_lessons: [LA, LB], quiz_lessons: [], review_lessons: [LA, LB], hw_deadline_override: '2026-10-01' });
  t('setup: group saved with two homework lessons', sg.ok === true, JSON.stringify(sg));

  // sara handed in lesson A through the real endpoint -> a Sheet row exists
  const sub = f.post({ action: 'upload_submission', student_id: f.P('sara'), name: 'Sara', subject: 'programming', lesson: slugA, submission_type: 'graded', score: 4, total: 5, answers: [{ id: 'q1' }], submitted_time: '2026-10-25T10:00:00Z', client_id: 'sara-cid-0001' });
  t('setup: sara\'s submission is on the sheet', sub.ok === true && dataRows('Submissions').length === 1, JSON.stringify(sub));

  // lamis: photos landed, submission never did (case B)
  const wa = DATA.insertSheet('WrittenAnswers');
  wa.appendRow(['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at', 'kind', 'graded_by', 'uploaded_at', 'image_ids']);
  wa.appendRow(['c:lamis-cid-0001', f.P('lamis'), LA, 'q1', 'file9', '', '', '', '', 'homework', '', '2026-10-26 10:00:00', 'img1']);

  // omar: the meta file is in Drive, the Sheet row is not (case A). The fake folder serves a fixed file list.
  const metaOmar = { student_id: f.P('omar'), name: 'Omar Ali', subject: 'programming', lesson: slugA, submission_type: 'graded', score: 3, total: 5, answers: [{ id: 'q1' }], submitted_time: '2026-10-26T10:00:00Z', date: '2026-10-26' };
  const files = [{ getName: () => 'programming--' + slugA + '--omar-ali--20261026T100000Z--meta.json', getBlob: () => ({ getDataAsString: () => JSON.stringify(metaOmar) }) },
                 { getName: () => 'written--x--img.jpg', getBlob: () => ({ getDataAsString: () => '' }) }];
  const folder = { getFiles: () => { let i = 0; return { hasNext: () => i < files.length, next: () => files[i++] }; }, searchFiles() { return this.getFiles(); }, createFile() { throw new Error('diagnosis/dry-run must never create a Drive file'); } };
  ctx.DriveApp.getFolderById = () => folder;
  // the lesson list as GitHub would report it: LA exists, LB does not (a key that matches no folder)
  vm.runInContext('_allLessonsFromGithub = function () { return { lessons: [{ lesson: ' + JSON.stringify(LA) + ' }] }; };', ctx);

  const subsBefore = dataRows('Submissions').length;
  const rep = ctx.p3_diagnose_core();
  const byCase = (lesson, k) => rep.items.filter(i => i.lesson === lesson && i.case === k).map(i => i.name);
  t('diagnosis: 8 expected, 1 found, 7 missing', rep.summary.expected === 8 && rep.summary.done === 1 && rep.summary.missing === 7, JSON.stringify(rep.summary));
  t('diagnosis: omar / lesson A = case A (meta file in Drive)', JSON.stringify(byCase(LA, 'A')) === JSON.stringify(['Omar Ali']), JSON.stringify(rep.items));
  t('diagnosis: lamis / lesson A = case B (photos only)', JSON.stringify(byCase(LA, 'B')) === JSON.stringify(['Lamis Adel']));
  t('diagnosis: hana / lesson A = case C (nothing on the server)', JSON.stringify(byCase(LA, 'C')) === JSON.stringify(['Hana Sami']));
  t('diagnosis: sara / lesson A is not reported (she is done)', rep.items.every(i => !(i.name === 'Sara Mahmoud' && i.lesson === LA)));
  t('diagnosis: lesson B is case C for all four', byCase(LB, 'C').length === 4);
  t('diagnosis: counts A=1 B=1 C=5', rep.summary.case_A === 1 && rep.summary.case_B === 1 && rep.summary.case_C === 5, JSON.stringify(rep.summary));
  t('diagnosis: everything is past its (2026-10-01) due date', rep.items.every(i => i.due_passed === true) && rep.summary.missing_due_passed === 7);
  t('H2: lesson B is flagged as matching no lesson folder, lesson A is not', rep.h2.length === 1 && rep.h2[0].lesson === LB, JSON.stringify(rep.h2));
  t('H3: reports which spreadsheet the dashboards read and its row counts', rep.h3.dashboards_read_from === 'DATA' && rep.h3.separate_data_sheet === true && rep.h3.data.Submissions.rows === 1, JSON.stringify(rep.h3));
  t('diagnosis is read-only: no sheet row added, no Drive file created', dataRows('Submissions').length === subsBefore && !DATA.getSheetByName('RecoveryReport'));

  // H3 stray copy in the students book
  const stray = f.getSS('STU').insertSheet('Submissions'); stray.appendRow(['student_id', 'lesson']); stray.appendRow(['x', 'y']);
  const rep2 = ctx.p3_diagnose_core();
  t('H3: rows found in the STUDENTS book are called out', /STUDENTS spreadsheet/.test(rep2.h3.note), rep2.h3.note);
  f.getSS('STU').sheets = f.getSS('STU').sheets.filter(s => s.name !== 'Submissions');

  // editor entry point writes the tab, and replaces (never appends to) it on the next run
  ctx.p3_diagnose_submissions();
  const rr1 = dataRows('RecoveryReport');
  ctx.p3_diagnose_submissions();
  const rr2 = dataRows('RecoveryReport');
  t('RecoveryReport tab: summary + h3 + 1 h2 + 7 missing rows', rr1.length === 10 && rr1.filter(r => r.kind === 'missing').length === 7, rr1.length);
  t('RecoveryReport tab: a second run replaces it, no growth', rr2.length === rr1.length);
  t('RecoveryReport: still no new Submissions row', dataRows('Submissions').length === subsBefore);

  // access
  const noAuth = (() => { try { ctx.p3_admin_diagnose_submissions({}); return 'allowed'; } catch (e) { return e.message; } })();
  t('p3_admin_diagnose_submissions refuses a caller with no admin proof', noAuth !== 'allowed' && noAuth !== '', noAuth);
  t('p3_admin_diagnose_submissions works with the admin token', ctx.p3_admin_diagnose_submissions({ token: 'tok' }).ok === true);

  // ---- restore
  const d1 = ctx.p3_restore_submissions();
  t('restore with no options is a DRY RUN: counts one row, writes none', d1.dry_run === true && d1.submission_rows === 1 && d1.quiz_rows === 0 && dataRows('Submissions').length === subsBefore, JSON.stringify(d1));
  t('restore dry-run says how many Drive files it scanned', d1.scanned === 1, d1.scanned);
  const d2 = ctx.p3_restore_submissions({ days: 0, dry_run: true });
  t('restore dry_run:true twice gives the same count (still nothing written)', d2.submission_rows === 1 && dataRows('Submissions').length === subsBefore);
  const real = ctx.p3_restore_submissions({ days: 0, dry_run: false });
  t('restore dry_run:false adds exactly the one missing row', real.dry_run === false && real.submission_rows === 1 && dataRows('Submissions').length === subsBefore + 1, JSON.stringify(real));
  const rowO = dataRows('Submissions').filter(r => String(r.student_id).indexOf(f.P('omar').slice(-10)) >= 0)[0];
  t('...the restored row carries omar\'s score and lesson', rowO && +rowO.score === 3 && rowO.lesson === slugA, JSON.stringify(rowO));
  const again = ctx.p3_restore_submissions({ days: 0, dry_run: false });
  t('restore is idempotent: running it again adds nothing', again.submission_rows === 0 && dataRows('Submissions').length === subsBefore + 1, JSON.stringify(again));
  t('restore (applied) is audited', f.rows && (() => { const a = DATA.getSheetByName('AuditLog'); if (!a) return false; for (let r = 2; r <= a.getLastRow(); r++) if (a.get(r, 3) === 'p3_restore_submissions') return true; return false; })());
  const rep3 = ctx.p3_diagnose_core();
  t('after the restore omar is no longer case A, and case B/C are unchanged', rep3.summary.case_A === 0 && rep3.summary.case_B === 1 && rep3.summary.case_C === 5, JSON.stringify(rep3.summary));

  // the temporary overrides never leak, even when the restore blows up
  const origAppend = ctx._appendByHeader, origLog = ctx.Logger.log;
  vm.runInContext('_restoreFromDrive = function () { throw new Error("boom"); };', ctx);
  let boom = ''; try { ctx.p3_restore_submissions({ dry_run: false }); } catch (e) { boom = e.message; }
  t('a failing restore rethrows', boom === 'boom', boom);
  t('...and puts _appendByHeader and Logger.log back', ctx._appendByHeader === origAppend && ctx.Logger.log === origLog);
  folder.createFile = () => ({ getId: () => 'fx', setTrashed() {} });
  t('...so a normal upload still works afterwards', f.post({ action: 'upload_submission', student_id: f.P('sara'), name: 'Sara', subject: 'programming', lesson: 'other-lesson', submission_type: 'text', text: 'hi', submitted_time: '2026-10-27T10:00:00Z', client_id: 'sara-cid-0002' }).ok === true);

  // ---- back-fill
  const bf = p => ctx.p3_admin_backfill_submission(Object.assign({ token: 'tok' }, p));
  const err = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
  t('backfill refuses a caller with no admin proof', err(() => ctx.p3_admin_backfill_submission({ student: f.P('hana'), lesson: LA, score: 4, total: 5 })) !== '');
  t('backfill refuses an unknown student', /No student account/.test(err(() => bf({ student: '01999999999', lesson: LA, score: 4, total: 5 }))));
  t('backfill refuses a score above the total', /between 0 and total/.test(err(() => bf({ student: f.P('hana'), lesson: LA, score: 6, total: 5 }))));
  t('backfill refuses a lesson with no subject', /full path/.test(err(() => bf({ student: f.P('hana'), lesson: 'just-a-slug', score: 1, total: 5 }))));
  const n0 = dataRows('Submissions').length;
  const b1 = bf({ student: f.P('hana'), lesson: LA, score: 4, total: 5, note: 'showed me the result screen' });
  t('backfill writes one row', b1.ok === true && dataRows('Submissions').length === n0 + 1, JSON.stringify(b1));
  const brow = dataRows('Submissions').filter(r => r.source === 'manual-backfill')[0];
  t('...marked source manual-backfill, graded, with subject + slug the follow-up page matches on', brow && brow.submission_type === 'graded' && brow.subject === 'programming' && brow.lesson === slugA && +brow.score === 4 && +brow.total === 5 && /manual-backfill/.test(brow.note), JSON.stringify(brow));
  t('...and the follow-up diagnosis now counts hana / lesson A as done', ctx.p3_diagnose_core().items.every(i => !(i.name === 'Hana Sami' && i.lesson === LA)));
  const b2 = bf({ student: f.P('hana'), lesson: LA, score: 4, total: 5 });
  t('the same back-fill twice is a no-op (duplicate:true, no new row)', b2.duplicate === true && dataRows('Submissions').length === n0 + 1, JSON.stringify(b2));
  t('a different score for a lesson that already has a row is refused without force', /already has a submission/.test(err(() => bf({ student: f.P('hana'), lesson: LA, score: 5, total: 5 }))));
  t('...and allowed with force:true', bf({ student: f.P('hana'), lesson: LA, score: 5, total: 5, force: true }).ok === true);
  t('backfill is audited', (() => { const a = DATA.getSheetByName('AuditLog'); if (!a) return false; for (let r = 2; r <= a.getLastRow(); r++) if (a.get(r, 3) === 'p3_admin_backfill_submission') return true; return false; })());

  // ======================= client =======================
  const files4 = {
    'assets/assign.js': read(path.join(SITE, 'assets', 'assign.js')),
    'assets/quiz.js': read(path.join(SITE, 'assets', 'quiz.js')),
    'templates/assign.js': read(path.join(QM, 'assets_templates', 'assign.js')),
    'templates/quiz.js': read(path.join(QM, 'assets_templates', 'quiz.js')),
  };
  const cut = (s, a, b) => { const i = s.indexOf(a); if (i < 0) throw new Error('marker missing: ' + a); const j = s.indexOf(b, i + a.length); if (j < 0) throw new Error('end marker missing: ' + b); return s.slice(i, j); };

  // --- assign.js: submission first, photos best-effort
  for (const name of ['assets/assign.js', 'templates/assign.js']) {
    const code = cut(files4[name], '      function uploadPhotos() {', '      function renderResult() {');
    const run = async (scenario) => {
      const calls = [], dequeued = [];
      const sb = {
        Promise, JSON, Object, Error, location: { pathname: '/programming/x/lesson/assignment.html' },
        session: { student_id: '01000000002', session_token: 'tok' },
        state: { record: { client_id: 'cid-abcdefgh', answers: [{ id: 'q1', type: 'written' }, { id: 'q2', type: 'written' }] }, widgets: {}, syncStatus: null, busy: false, photoStatus: null },
        render() {}, dequeueSubmission: id => dequeued.push(id),
        postToDrive: (p) => { calls.push(p.action); if (p.action === 'upload_submission') return scenario.submissionFails ? Promise.reject(new Error('Couldn\'t reach the server.')) : Promise.resolve({ ok: true });
          return scenario.photosRefused ? Promise.reject(new Error('Feature disabled: FF_CAMERA')) : Promise.resolve({ ok: true }); },
      };
      let cleared = 0;
      const widget = { upload: (send) => send({ id: 'img-00000001' }, 'b64').then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message })), clear: () => { cleared++; } };
      sb.state.widgets = { q1: widget, q2: widget };
      vm.createContext(sb);
      vm.runInContext(code + '\nthis.sendRecord = sendRecord;', sb);
      sb.sendRecord();
      await new Promise(r => setTimeout(r, 30));
      return { calls, dequeued, cleared, state: sb.state };
    };
    let r = await run({ photosRefused: true });
    t(name + ': the submission is posted FIRST', r.calls[0] === 'upload_submission', r.calls.join(','));
    t(name + ': photos refused (FF_CAMERA off) -> the submission is still delivered and confirmed', r.state.syncStatus === 'ok' && r.dequeued[0] === 'cid-abcdefgh');
    t(name + ': ...photoStatus is "later", the photos stay on the device (not cleared)', r.state.photoStatus === 'later' && r.cleared === 0 && Object.keys(r.state.widgets).length === 2, JSON.stringify([r.state.photoStatus, r.cleared]));
    r = await run({});
    t(name + ': photos fine -> submission, then both photos, then the drafts are cleared', r.calls.join(',') === 'upload_submission,upload_written_image,upload_written_image' && r.state.photoStatus === 'ok' && r.cleared === 2 && Object.keys(r.state.widgets).length === 0, r.calls.join(','));
    r = await run({ submissionFails: true });
    t(name + ': the submission failing shows "failed", does not touch the photos, keeps the record queued', r.state.syncStatus === 'failed' && r.calls.join(',') === 'upload_submission' && r.dequeued.length === 0 && r.cleared === 0, r.calls.join(','));
  }

  // --- both scripts: the queue is re-sent for the right student only, and leaves the queue on success
  for (const name of ['assets/assign.js', 'assets/quiz.js', 'templates/assign.js', 'templates/quiz.js']) {
    const src = files4[name];
    const dequeue = cut(src, '  function dequeueSubmission(', '\n  }\n') + '\n  }\n';
    const resend = cut(src, '  var MAX_RESEND = 10;', '  // A one-line notice');
    const store = { teaching_pending_submissions: JSON.stringify([
      { type: 'assignment', client_id: 'a-1', student_id: '01000000002', subject: 'programming', lesson: 'l1' },
      { type: 'quiz', client_id: 'q-1', student_id: '01000000002', subject: 'programming', lesson: 'l1' },
      { type: 'assignment', client_id: 'b-1', student_id: '01000000003', subject: 'programming', lesson: 'l1' },     // another student on a shared device
      { type: 'assignment', student_id: '01000000002', subject: 'programming', lesson: 'old' },                       // no client_id: cannot be deduped, never re-sent
      { type: 'assignment', client_id: 'a-2', student_id: '01000000002', subject: 'programming', lesson: 'l2' },
    ]) };
    const sent = [];
    const sb = { Promise, JSON, Object, String, Math, QUEUE_KEY: 'teaching_pending_submissions', localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
      postToDrive: (p) => { sent.push(p.action + ':' + p.client_id); return p.client_id === 'a-2' ? Promise.reject(new Error('net')) : Promise.resolve({ ok: true }); } };
    vm.createContext(sb);
    vm.runInContext(dequeue + '\n' + resend + '\nthis.resendPending = resendPending; this.pendingFor = pendingFor;', sb);
    const events = [];
    await sb.resendPending({ student_id: '01000000002' }, e => events.push(e.state));
    t(name + ': re-sends only this student\'s queued records, with the right action for each type', sent.join(',') === 'upload_submission:a-1,upload_quiz_result:q-1,upload_submission:a-2', sent.join(','));
    const left = JSON.parse(store.teaching_pending_submissions).map(r => r.client_id || '(none)');
    t(name + ': confirmed records leave the queue; a failed one, other students\' and id-less ones stay', left.join(',') === 'b-1,(none),a-2', left.join(','));
    t(name + ': reports sending -> failed (one record did not go)', events.join(',') === 'sending,failed', events.join(','));
    sent.length = 0;
    const n = await sb.resendPending({ student_id: '01000000009' }, () => {});
    t(name + ': a student with nothing queued sends nothing', n === 0 && sent.length === 0);
  }

  // --- quiz.js deferred flow: answers first, photos after, review last (source-order check: the page needs a browser)
  for (const name of ['assets/quiz.js', 'templates/quiz.js']) {
    const body = cut(files4[name], '      function submitD() {', '      function renderSending() {');
    const sendAnswers = cut(body, '      function sendAnswers() {', '      function fetchReview() {');
    t(name + ': submitD no longer uploads photos itself', !/upload_written_image/.test(cut(body, '      function submitD() {', '      function sendPhotos() {')));
    t(name + ': sendAnswers posts the answers, THEN sendPhotos, THEN fetchReview',
      sendAnswers.indexOf('post(record') >= 0 && sendAnswers.indexOf('post(record') < sendAnswers.indexOf('sendPhotos()') && sendAnswers.indexOf('sendPhotos()') < sendAnswers.indexOf('fetchReview()'));
    t(name + ': a failed photo only counts toward photosLater (never throws or stops the review)', /failed\+\+/.test(body) && /st\.photosLater = failed/.test(body) && !/throw new Error/.test(cut(body, '      function sendPhotos() {', '      function sendAnswers() {')));
    t(name + ': the review keeps unsent photos and offers "Send photos again"', /if \(!st\.photosLater\)/.test(body) && /Send photos again/.test(files4[name]));
  }

  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
