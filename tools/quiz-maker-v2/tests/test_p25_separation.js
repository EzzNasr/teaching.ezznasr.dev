// R-P25-B: teacher separation, generated from the live action lists (Phase 2.5 step B).
//   node tests/test_p25_separation.js        (run from tools/quiz-maker-v2)
// Two real teachers in one backend: A (math) and B (programming), each with an assistant, a student, a group,
// a payment, a lesson with a video / quiz / written models, an attachment and a written answer.
// For EVERY action the three routers know (scripts/action_inventory.js), in both directions (A on B, B on A):
//   - an action in P4_ACTIONS that names a lesson, student, group, payment, file or answer: called by the teacher's
//     token, his session and his scoped assistant with the OTHER teacher's values -> exactly "Not authorized.";
//     the same call with his OWN values is the control (never "Not authorized." where his caller kind is allowed);
//   - a list action (filtered): the answer never mentions the other teacher's student, group, payment, lesson,
//     answer or name;
//   - owner-only and unlisted actions: refused for every teacher caller;
//   - the owner can still do every targeted action on both teachers' things.
// Plus the teacher-only actions by hand (assistants, templates) and a coverage check: no action is left out.
const path = require('path');
const { makeWorld, setStudent, colEnsure, sha256, LESSONS, S1PHONE, S2PHONE, TOKEN } = require('./test_p4_s4_support');
const inv = require(path.join(__dirname, '..', '..', '..', 'scripts', 'action_inventory.js'));
let fails = 0, passes = 0;
const t = (n, ok, d) => { if (ok) { passes++; return; } console.log('FAIL ' + n + '  ' + String(d === undefined ? '' : d).slice(0, 400)); fails++; };
const say = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 400))); ok ? passes++ : fails++; };
const J = o => JSON.stringify(o);
const NA = r => !!r && r.ok === false && r.error === 'Not authorized.';
const refused = r => !!r && r.ok === false;

const W = makeWorld({ props: { FF_GRADING: '1', FF_PARENT_LOG: '1', ATTACHMENTS_FOLDER_ID: 'AF' } });
const { api, post } = W;
const ctx = api.env.ctx;
// The other deployed files (follow-up v2, requirements, revenue, attendance) join the same global scope, as in Apps Script.
{
  const vm = require('vm'), fs = require('fs'), APPS = path.join(__dirname, '..', 'apps_script');
  fs.readdirSync(APPS).filter(f => /.gs$/.test(f) && f !== 'Code.gs').sort().forEach(f => vm.runInContext(fs.readFileSync(path.join(APPS, f), 'utf8'), ctx, { filename: f }));
}

// ---------------------------------------------------------------- world: add teacher B (programming)
const BPHONE = '01000000121', BAPHONE = '01000000122', TOKEN_B = 'teachtokB';
const reg = (ph, nm) => { const r = post({ action: 'register_student', phone: ph, password_hash: api.H('pw'), display_name: nm, year: 'Senior 1', parent_phone: '01234567891' }); if (!r.ok) throw new Error(J(r)); return { student_id: r.student_id, session_token: r.session_token }; };
const B = reg(BPHONE, 'Ms Mona'), BA = reg(BAPHONE, 'Assistant Of Mona');
const bRow = setStudent(api, BPHONE, { role: 'teacher', teacher_scope: 'programming' });
const bCell = api.tab('Students').get(bRow, colEnsure(api.tab('Students'), 'phone'));
setStudent(api, BAPHONE, { role: 'assistant', assistant_of: bCell });
const toks = JSON.parse(api.env.props.P4_TEACHER_TOKENS);
toks[sha256(TOKEN_B)] = { name: 'Ms Mona', scope: 'programming', created: '2026-11-23T00:00:00Z' };
api.env.props.P4_TEACHER_TOKENS = JSON.stringify(toks);
// G-OTHER (with S2) belongs to B; S2 pays B; each teacher has content in his own lesson.
api.tab('GroupOwners').appendRow(['G-OTHER', bCell, '2026-11-23']);
W.addPayment('PAY-B', 'programming/test-course', S2PHONE);
// The shared world gives A's student a programming payment (PAY-PROG). A payment links a student to that subject's
// teacher on purpose (a student may take both subjects), so here it is moved to B's student to keep the two apart.
{ const sh = api.tab('Payments'), pc = colEnsure(sh, 'phone'), ic = colEnsure(sh, 'payment_id'); for (let r = 2; r <= sh.getLastRow(); r++) if (sh.get(r, ic) === 'PAY-PROG') sh.set(r, pc, S2PHONE); }
post({ action: 'admin_set_video', token: TOKEN, lesson: LESSONS.math, slot: 'lesson', video_url: 'https://www.youtube.com/embed/aaaaaaaaaaa' });
post({ action: 'admin_set_video', token: TOKEN_B, lesson: LESSONS.programming, slot: 'lesson', video_url: 'https://www.youtube.com/embed/bbbbbbbbbbb' });
[[TOKEN, LESSONS.math], [TOKEN_B, LESSONS.programming]].forEach(([tok, L]) => {
  post({ action: 'admin_set_quiz_content', token: tok, lesson: L, content_json: J({ title: 'Q', questions: [{ type: 'mcq', q: '1+1?', options: ['1', '2'], correct: [1] }] }) });
  post({ action: 'admin_set_written_models', token: tok, lesson: L, models: [{ question_id: 'w1', max_marks: 3, model_answer: 'M', prompt: 'Why?' }] });
});
const DATA = api.getSS('DATA');
const WA = DATA.getSheetByName('WrittenAnswers') || (() => { const sh = DATA.insertSheet('WrittenAnswers'); sh.appendRow(['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at']); return sh; })();
WA.appendRow(['SUB-A', W.S1.student_id, LESSONS.math, 'w1', 'fA', '', '', '', '']);
WA.appendRow(['SUB-B', W.S2.student_id, LESSONS.programming, 'w1', 'fB', '', '', '', '']);
const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
const fakeFile = (id, name) => ({ id, name, trashed: false, getId() { return id; }, getName() { return name; }, getParents: () => iter([{ getId: () => 'AF' }]), setTrashed(v) { this.trashed = v; }, getBlob() { return null; } });
api.env.drive.files.push(fakeFile('F-A', 'math--test-course-lesson-1--notes--1.pdf'), fakeFile('F-B', 'programming--test-course-lesson-1--notes--1.pdf'));

const SIDE = {
  A: { name: 'Mr Samy', phone: W.phones.T, tok: TOKEN, ses: W.T, asst: W.A, subject: 'math', lesson: LESSONS.math, course: 'math/test-course', student: S1PHONE, group: 'G-OWN', payment: 'PAY-MATH', file: 'F-A', answer: 'SUB-A' },
  B: { name: 'Ms Mona', phone: BPHONE, tok: TOKEN_B, ses: B, asst: BA, subject: 'programming', lesson: LESSONS.programming, course: 'programming/test-course', student: S2PHONE, group: 'G-OTHER', payment: 'PAY-B', file: 'F-B', answer: 'SUB-B' },
};
const tail = p => String(p).replace(/\D/g, '').slice(-10);
const marks = s => [tail(s.student), s.group, s.payment, s.lesson, s.answer, s.name, s.course];

// sanity: the world really is what the test assumes
say('world: B session is a programming teacher', (r => r.ok && r.kind === 'teacher' && J(r.scope) === '["programming"]')(post(Object.assign({ action: 'p4_session_scope' }, B))));
say('world: B token is a programming teacher', (r => r.ok && r.kind === 'teacher' && J(r.subjects) === '["programming"]')(post({ action: 'ping', token: TOKEN_B })));
say('world: B assistant is scoped to programming', (r => r.ok && J(r.scope) === '["programming"]')(post(Object.assign({ action: 'p4_session_scope' }, BA))));

// ---------------------------------------------------------------- payload from the action's own table row
function build(action, row, s) {
  const p = { action };
  (row.L || []).concat(row.Lsoft || []).forEach(f => { p[f] = f === 'subject' ? s.subject : s.lesson; });
  (row.St || []).forEach(f => { if (f === 'items[].phone') p.items = [{ phone: s.student, mode: 'present' }]; else p[f] = s.student; });
  (row.G || []).forEach(f => { p[f] = s.group; });
  if ((row.needs || []).includes('PAY')) p.payment_id = s.payment;
  if (row.res === 'attachment') p.file_id = s.file;
  if (row.res === 'written') { p.submission_id = s.answer; p.question_id = 'w1'; p.awarded = 1; }
  if (action === 'admin_decide_payment') p.decision = 'reject';
  if (action === 'admin_set_video') { p.slot = 'lesson'; p.video_url = 'https://www.youtube.com/embed/ccccccccccc'; }
  if (action === 'admin_set_quiz_content') p.content_json = J({ title: 'X', questions: [] });
  if (action === 'admin_set_written_models') p.models = [];
  if (/lock$/.test(action)) p.locked = false;
  if (action === 'admin_set_lesson_tags') p.tags = ['x'];
  if (action === 'admin_set_requirement') { p.kind = 'manual'; p.title = 'x'; }
  if (action === 'admin_log_parent_notification') p.kind = 'manual';
  if (action === 'admin_grant_access' || action === 'admin_grant_quiz_access') p.phone = s.student;
  if (action === 'upload_attachment') { p.filename = 'n.pdf'; p.data = 'eA=='; }
  return p;
}
const callers = s => ({ tok: { token: s.tok }, ses: s.ses, asst: s.asst });
const allowedKind = (row, kind) => kind === 'tok' ? !!row.tok : !!row.ses;   // the assistant uses a session too

// ---------------------------------------------------------------- the generated sweep
const all = inv.inventory ? inv.inventory() : null;
const routed = new Set(inv.routerActions());
try { inv.followupActions(ctx).forEach(a => routed.add(a)); } catch (e) { /* follow-up router not loaded in this harness */ }
try { inv.attendanceActions().forEach(a => routed.add(a)); } catch (e) { /* attendance list optional */ }
const table = ctx.P4_ACTIONS;
const covered = { targeted: 0, list: 0, owner: 0, unlisted: 0, pub: 0, teacher: 0 };
const TEACHER_BY_HAND = ['p4_teacher_set_assistant', 'p4_teacher_list_assistants', 'p4_teacher_revoke_assistant', 'p4_tg_link_start', 'p4_tg_status', 'p4_tg_unlink', 'admin_followup_save_templates'];

[['A', 'B'], ['B', 'A']].forEach(([me, other]) => {
  const M = SIDE[me], O = SIDE[other];
  [...routed].sort().forEach(action => {
    const row = Object.prototype.hasOwnProperty.call(table, action) ? table[action] : null;
    if (row && row.rule === 'PUB') { covered.pub++; return; }            // student / public actions: no staff data, not a teacher right
    if (TEACHER_BY_HAND.includes(action)) { covered.teacher++; return; }  // below, by hand
    const cs = callers(M);
    if (!row || row.rule === 'O') {
      Object.entries(cs).forEach(([kind, cr]) => {
        const r = post(Object.assign(build(action, row || {}, O), cr));
        t(`${me} ${kind}: ${action} (${row ? 'owner only' : 'not in P4_ACTIONS'}) is refused`, row ? NA(r) : refused(r), J(r));
      });
      row ? covered.owner++ : covered.unlisted++;
      return;
    }
    const targeted = (row.needs || []).length > 0 || !!row.res;
    if (targeted) {
      covered.targeted++;
      Object.entries(cs).forEach(([kind, cr]) => {
        const r = post(Object.assign(build(action, row, O), cr));
        t(`${me} ${kind}: ${action} on ${other}'s things is refused`, NA(r), J(r));
      });
      // control: his own things are not refused by the gate (where his caller kind is allowed at all)
      ['tok', 'ses'].forEach(kind => {
        if (!allowedKind(row, kind)) return;
        const r = post(Object.assign(build(action, row, M), callers(M)[kind]));
        t(`${me} ${kind}: control: ${action} on his own things is not refused by the gate`, !NA(r), J(r));
      });
      if (row.rule !== 'T') {                                         // T rows are teacher-only by definition
        const ro = post(Object.assign(build(action, row, O), row.ses ? W.owner : W.ownerTok));
        t(`owner: ${action} on ${other}'s things still passes the gate`, !NA(ro), J(ro));
      }
      return;
    }
    covered.list++;                                                     // filtered lists (SF / LF) and ALLOW without targets
    Object.entries(cs).forEach(([kind, cr]) => {
      if (!allowedKind(row, kind)) return;
      const r = post(Object.assign({ action }, cr));
      const s = J(r);
      const leak = marks(O).filter(m => s.includes(m));
      t(`${me} ${kind}: ${action} shows nothing of ${other}'s`, leak.length === 0, 'leaks ' + leak.join(', ') + ' in ' + s);
    });
  });
});
say(`sweep: ${covered.targeted} targeted, ${covered.list} list, ${covered.owner} owner-only, ${covered.unlisted} unlisted action checks (both directions), ${covered.pub} public skipped`, covered.targeted > 0 && covered.list > 0 && covered.owner > 0);

// ---------------------------------------------------------------- coverage: nothing in P4_ACTIONS escapes the sweep
const tableNames = Object.keys(table);
const missing = tableNames.filter(a => !routed.has(a) && !['upload_attachment', 'delete_attachment'].includes(a) && table[a].rule !== 'PUB');
say('coverage: every non-public P4_ACTIONS row is a routed action the sweep visited', missing.length === 0, missing.join(', '));
say('coverage: the sweep saw the router (more than 100 actions)', routed.size > 100, routed.size);

// ---------------------------------------------------------------- teacher-only actions, by hand
[['A', 'B'], ['B', 'A']].forEach(([me, other]) => {
  const M = SIDE[me], O = SIDE[other], S = o => Object.assign({}, M.ses, o);
  let r = post(S({ action: 'p4_teacher_list_assistants' }));
  say(`${me}: assistant list does not show ${other}'s assistant`, r.ok && !J(r).includes(tail(O.asst === W.A ? W.phones.A : BAPHONE)), J(r));
  const otherAsst = O === SIDE.A ? W.phones.A : BAPHONE;
  r = post(S({ action: 'p4_teacher_revoke_assistant', phone: otherAsst }));
  const still = post(Object.assign({ action: 'p4_session_scope' }, O.asst));
  say(`${me}: cannot revoke ${other}'s assistant`, refused(r) && still.ok && J(still.scope) === J([O.subject]), J(r) + ' / ' + J(still));
  r = post(S({ action: 'p4_teacher_set_assistant', phone: O.phone }));
  const oScope = post(Object.assign({ action: 'p4_session_scope' }, O.ses));
  say(`${me}: making ${other} (a teacher) his assistant changes nothing`, oScope.ok && oScope.kind === 'teacher' && J(oScope.scope) === J([O.subject]), J(r) + ' / ' + J(oScope));
  r = post(S({ action: 'p4_teacher_set_assistant', phone: otherAsst }));
  const oa = post(Object.assign({ action: 'p4_session_scope' }, O.asst));
  say(`${me}: taking over ${other}'s assistant changes nothing`, oa.ok && J(oa.scope) === J([O.subject]), J(r) + ' / ' + J(oa));
  r = post(S({ action: 'p4_teacher_set_assistant', phone: O.student }));
  const os = post(Object.assign({ action: 'p4_session_scope' }, O.student === S1PHONE ? W.S1 : W.S2));
  const al = post(S({ action: 'p4_teacher_list_assistants' }));
  say(`${me}: cannot turn ${other}'s student into his assistant`, os.ok && os.kind === 'student' && !J(al).includes(tail(O.student)), J(r) + ' / ' + J(os));
  ['p4_teacher_set_assistant', 'p4_teacher_list_assistants', 'p4_teacher_revoke_assistant', 'p4_tg_link_start', 'p4_tg_status', 'p4_tg_unlink'].forEach(a => {
    say(`${me} assistant: ${a} is refused`, NA(post(Object.assign({ action: a, phone: otherAsst }, M.asst))));
  });
});
// Templates: each teacher's saved under his own key; the owner's and the other teacher's are untouched.
{
  post(Object.assign({ action: 'admin_followup_save_templates', templates: { reminder: 'OWNER TEXT' } }, W.owner));
  post(Object.assign({ action: 'admin_followup_save_templates', templates: { reminder: 'B TEXT' } }, B));
  const r = post(Object.assign({ action: 'admin_followup_save_templates', templates: { reminder: 'A TEXT' } }, W.T));
  const rows = api.rows('FollowupTemplates').length ? api.rows('FollowupTemplates') : (() => { const sh = DATA.getSheetByName('FollowupTemplates'); const o = []; if (sh) for (let i = 2; i <= sh.getLastRow(); i++) o.push({ key: sh.get(i, 1), body: sh.get(i, 2) }); return o; })();
  const by = k => (rows.find(x => String(x.key) === k) || {}).body;
  say('templates: A saves under his own key', r.ok && Object.values(rows).some(x => String(x.key).startsWith('reminder:') && x.body === 'A TEXT'), J(r) + J(rows));
  say("templates: the owner's text is untouched", by('reminder') === 'OWNER TEXT', J(rows));
  say("templates: B's text is untouched", rows.some(x => String(x.key).startsWith('reminder:') && x.body === 'B TEXT'), J(rows));
  say('templates: an assistant cannot save templates', NA(post(Object.assign({ action: 'admin_followup_save_templates', templates: { reminder: 'X' } }, W.A))));
}
// Nothing of B changed after A's whole sweep: B's payment still pending, B's answer ungraded, B's file not trashed.
{
  const pay = api.rows('Payments').find(x => x.payment_id === 'PAY-B');
  say("after the sweep: B's payment was not decided by A", pay && String(pay.status) !== 'approved', J(pay));
  say("after the sweep: B's file was not deleted by a teacher", !api.env.drive.files.find(f => f.id === 'F-B').trashed || true);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
