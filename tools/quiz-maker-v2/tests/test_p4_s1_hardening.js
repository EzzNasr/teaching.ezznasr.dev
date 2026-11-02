// P4-S1 hardening: delete_attachment only inside the attachments folder, and the two upload handlers check the
// student's session (with a legacy switch, P4_LEGACY_UPLOADS). Runs the real Code.gs in the fake Apps Script.
//   node tests/test_p4_s1_hardening.js apps_script/Code.gs      (run from tools/quiz-maker-v2)
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
let pass = 0, fail = 0;

// Code.gs reaches the repo only through patches/S1-hardening.diff (contract section 8), applied at assembly. Until then the
// repo's Code.gs is the unpatched base, so this test builds a patched copy from the diff and feeds THAT to the shared fixture
// (which always reads apps_script/Code.gs) by intercepting that single read. After assembly Code.gs already carries the
// change, the diff is not needed, and nothing is intercepted.
(function useLoadedPatch() {
  const CODE = path.join(__dirname, '..', 'apps_script', 'Code.gs');
  const src = fs.readFileSync(CODE, 'utf8');
  if (src.indexOf('P4-S1 (plan 0.2)') !== -1) return;
  const diff = [path.join(__dirname, '..', '..', '..', '..', 'patches', 'S1-hardening.diff'),
                path.join(__dirname, '..', '..', '..', 'patches', 'S1-hardening.diff'),
                path.join(__dirname, '..', 'patches', 'S1-hardening.diff')].find(fs.existsSync);
  if (!diff) { console.log('FAIL Code.gs has no P4-S1 change and patches/S1-hardening.diff was not found next to the repo'); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4s1-')), patched = path.join(tmp, 'Code.gs');
  fs.writeFileSync(patched, src);
  const r = cp.spawnSync('patch', ['-s', '-N', patched, diff], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('FAIL patches/S1-hardening.diff does not apply to Code.gs: ' + (r.stdout || '') + (r.stderr || '')); process.exit(1); }
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) { return real.call(fs, (typeof p === 'string' && path.resolve(p) === CODE) ? patched : p, ...rest); };
  console.log('NOTE testing Code.gs + patches/S1-hardening.diff (applied to a temp copy)');
})();
const { makeEnv } = require('./fixtures/phase2_env');
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };

// ---- a tiny Drive with real parent folders (the shared harness has none) -------------------------------------------------
function installDrive(api) {
  const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const folders = {}, files = {};
  const folder = (id, parents) => (folders[id] = { id, parents: parents || [], getId() { return id; }, getParents() { return iter(this.parents.map(p => folders[p])); } });
  const file = (id, parents) => (files[id] = { id, trashed: false, parents, getId() { return id; }, getParents() { return iter(this.parents.map(p => folders[p])); }, setTrashed(v) { this.trashed = v; } });
  api.env.ctx.DriveApp.getFileById = id => { if (!files[id]) throw new Error('File not found: ' + id); return files[id]; };
  return { folder, file, files };
}
const del = (api, file_id, token) => api.post({ action: 'delete_attachment', token: token === undefined ? 'tok' : token, file_id });

// ---- delete_attachment ---------------------------------------------------------------------------------------------------
{
  const api = makeEnv();
  api.env.props.ATTACHMENTS_FOLDER_ID = 'ATT';
  const d = installDrive(api);
  d.folder('ATT'); d.folder('SUB', ['ATT']); d.folder('SUBSUB', ['SUB']); d.folder('OTHER'); d.folder('LOOPA', ['LOOPB']); d.folder('LOOPB', ['LOOPA']);
  d.file('in-root', ['ATT']); d.file('in-sub', ['SUBSUB']); d.file('outside', ['OTHER']); d.file('orphan', []); d.file('loop', ['LOOPA']); d.file('multi', ['OTHER', 'ATT']);

  let r = del(api, 'in-root');
  t('delete: a file directly inside the attachments folder is trashed', r.ok === true && d.files['in-root'].trashed === true, JSON.stringify(r));
  r = del(api, 'in-sub');
  t('delete: a file in a sub-folder of the attachments folder is trashed (parent chain)', r.ok === true && d.files['in-sub'].trashed === true, JSON.stringify(r));
  r = del(api, 'multi');
  t('delete: a file with several parents, one of them the attachments folder, is trashed', r.ok === true && d.files['multi'].trashed === true, JSON.stringify(r));
  r = del(api, 'outside');
  t('delete: a file outside the attachments folder is refused', r.ok === false && r.error === 'Not authorized.', JSON.stringify(r));
  t('delete: ...and it was NOT trashed', d.files['outside'].trashed === false);
  r = del(api, 'orphan');
  t('delete: a file with no parent folder is refused and not trashed', r.ok === false && d.files['orphan'].trashed === false, JSON.stringify(r));
  r = del(api, 'loop');
  t('delete: a looping parent chain terminates, is refused and not trashed', r.ok === false && d.files['loop'].trashed === false, JSON.stringify(r));
  r = del(api, 'no-such-file');
  t('delete: an unknown file id is refused with the same message', r.ok === false && r.error === 'Not authorized.', JSON.stringify(r));
  r = del(api, 'in-root', 'wrong-token');
  t('delete: a wrong admin token is still refused first', r.ok === false && r.error === 'Not authorized.', JSON.stringify(r));
  d.file('again', ['ATT']);
  delete api.env.props.ATTACHMENTS_FOLDER_ID;
  r = del(api, 'again');
  t('delete: ATTACHMENTS_FOLDER_ID not set -> refused, nothing trashed (fails closed)', r.ok === false && d.files['again'].trashed === false, JSON.stringify(r));
  r = del(api, '');
  t('delete: missing file_id keeps its own message', r.ok === false && /file_id/.test(r.error), JSON.stringify(r));
}

// ---- uploads: session checks ---------------------------------------------------------------------------------------------
const dataRows = (api, tab) => { const sh = api.getSS('DATA').getSheetByName(tab); return sh ? Math.max(sh.getLastRow() - 1, 0) : 0; };
const sub = (api, who, id, extra) => Object.assign({ action: 'upload_submission', student_id: api.P(who), name: who, subject: 'programming', lesson: 'l1', submission_type: 'text', text: 'answer ' + id, submitted_time: '2026-10-20T10:00:00Z', client_id: id }, extra || {});
const quiz = (api, who, id, extra) => Object.assign({ action: 'upload_quiz_result', student_id: api.P(who), name: who, subject: 'programming', lesson: 'l1', quiz_title: 'Q', start_time: '2026-10-20T10:00:00Z', end_time: '2026-10-20T10:05:00Z', score: 3, total: 5, questions: [], client_id: id }, extra || {});

[['upload_submission', sub, 'Submissions'], ['upload_quiz_result', quiz, 'QuizResults']].forEach(([action, build, tab]) => {
  const api = makeEnv();
  const tok = api.S('sara').session_token;
  let r = api.post(build(api, 'sara', 'a1', { session_token: tok }));
  t(action + ': a valid session works', r.ok === true && dataRows(api, tab) === 1, JSON.stringify(r));

  const files = api.env.drive.files.length;
  r = api.post(build(api, 'sara', 'a2', { session_token: 'not-the-token' }));
  t(action + ': a bad session_token is refused', r.ok === false && /Session expired|log in/i.test(r.error), JSON.stringify(r));
  t(action + ': ...no row and no Drive file created', dataRows(api, tab) === 1 && api.env.drive.files.length === files);

  r = api.post(build(api, 'sara', 'a3', { session_token: api.S('omar').session_token }));
  t(action + ': another student\'s valid token does not work for this student_id', r.ok === false, JSON.stringify(r));

  r = api.post(build(api, 'sara', 'a4'));
  t(action + ': NO session works while P4_LEGACY_UPLOADS is unset (queued records from before the change)', r.ok === true && dataRows(api, tab) === 2, JSON.stringify(r));
  api.env.props.P4_LEGACY_UPLOADS = '1';
  r = api.post(build(api, 'sara', 'a5'));
  t(action + ': NO session works while P4_LEGACY_UPLOADS is "1"', r.ok === true && dataRows(api, tab) === 3, JSON.stringify(r));
  r = api.post(build(api, 'sara', 'a5b', { session_token: 'bad' }));
  t(action + ': legacy mode does not excuse a token that was sent but is wrong', r.ok === false, JSON.stringify(r));

  api.env.props.P4_LEGACY_UPLOADS = '0';
  const before = dataRows(api, tab);
  r = api.post(build(api, 'sara', 'a6'));
  t(action + ': NO session is refused once P4_LEGACY_UPLOADS is "0"', r.ok === false && /session/i.test(r.error) && dataRows(api, tab) === before, JSON.stringify(r));
  r = api.post(build(api, 'sara', 'a7', { session_token: tok }));
  t(action + ': a valid session still works when P4_LEGACY_UPLOADS is "0"', r.ok === true && dataRows(api, tab) === before + 1, JSON.stringify(r));
  r = api.post(build(api, 'sara', 'a8', { student_id: undefined, session_token: tok }));
  t(action + ': missing student_id keeps its own message', r.ok === false && /student_id/.test(r.error), JSON.stringify(r));
});

// ---- client side: the session is attached at send time, from the live session, and never stored in the queue ----------------
{
  const fs = require('fs'), vm = require('vm');
  const site = path.join(__dirname, '..', '..', '..');
  // withSession sends: quiz.js = resend + the live quiz send. assign.js = resend + the plain (text/link/file) send.
  // assign.js's graded send carries session.session_token inline instead (the same way its photo upload already does), because
  // test_p3_recovery.js evaluates that block alone in a sandbox that has `session` but no helpers.
  const files = { 'assets/quiz.js': [2, 'quiz'], 'assets/assign.js': [2, 'assign'], 'tools/quiz-maker-v2/assets_templates/quiz.js': [2, 'quiz'], 'tools/quiz-maker-v2/assets_templates/assign.js': [2, 'assign'] };
  Object.keys(files).forEach(f => {
    const s = fs.readFileSync(path.join(site, f), 'utf8').replace(/\r\n/g, '\n');
    const n = (s.match(/postToDrive\(withSession\(session, /g) || []).length;
    t(f + ': ' + files[f][0] + ' upload sends go through withSession (resend + each live send)', n === files[f][0], n);
    t(f + ': no upload_submission / upload_quiz_result send goes out without a session (none left bare)', !/postToDrive\(Object\.assign\(\{ action: "upload_(submission|quiz_result)" \}/.test(s));
    if (files[f][1] === 'assign') t(f + ': the graded send carries session.session_token inline', /action: "upload_submission", session_token: session\.session_token \}, state\.record\)/.test(s));
    t(f + ': the queued record is never given a session_token', !/queueSubmission\([^)]*session_token/.test(s) && !/session_token\s*:[^\n]*queue/i.test(s));
    const a = s.indexOf('  function withSession('), b = s.indexOf('\n  }\n', a) + 4;
    const sb = {}; vm.createContext(sb); vm.runInContext(s.slice(a, b) + '\nthis.withSession = withSession;', sb);
    const p = sb.withSession({ session_token: 'T1' }, { action: 'x' });
    t(f + ': withSession adds the live token', p.session_token === 'T1');
    t(f + ': ...keeps one that is already set, and does nothing without a session', sb.withSession({ session_token: 'T2' }, { session_token: 'OLD' }).session_token === 'OLD' && !('session_token' in sb.withSession(null, { a: 1 })));
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
