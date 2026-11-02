// R-P4-S4-05 (pending until assembly): the scripted version of plan section 9, steps 1-12 and 15, against the REAL
// merged and wired backend in the shared harness. Steps 13 and 14 (Save button, owner dashboards) are browser
// behaviour and are covered by S7's jsdom tests (test_p4_s7_*). Every step is independent: one failing step never
// hides the others. Telegram and phone-cascade steps need S5/S6 to be merged.
const fs = require('fs'), path = require('path');
const { makeWorld, LESSONS, S1PHONE, S2PHONE, APHONE, LPHONE, TPHONE, TOKEN } = require('./test_p4_s4_support');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'p4_matrix.json'), 'utf8'));
const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8');
let fails = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 500))); if (!ok) fails++; };
if (!/function p4_gate\(/.test(CODE)) { t('Phase 4 is merged and wired into Code.gs', false, 'run scripts/p4_wire.py --merge --wire'); process.exit(1); }

const W = makeWorld({ props: { FF_GRADING: '1', TELEGRAM_WEBHOOK_SECRET: 'sec', P4_TEACHER_PHONE_EDIT: '1' } });
const { api, post } = W;
const tgPost = u => JSON.parse(api.env.ctx.doPost({ parameter: { tg: 'sec' }, postData: { contents: JSON.stringify(u) } }).text);
const NA = r => r && r.ok === false && r.error === 'Not authorized.';
const J = o => JSON.stringify(o);
const tail = p => String(p).replace(/\D/g, '').slice(-10);
const TS = Object.assign({ }, W.T), AS = W.A, LS = W.L, OS = W.owner, S1S = W.S1;
const T = (o) => Object.assign({}, W.T, o), O = (o) => Object.assign({}, W.owner, o), A = (o) => Object.assign({}, W.A, o);
const payStatus = id => { const r = api.rows('Payments').find(x => x.payment_id === id); return r ? String(r.status) : '(missing)'; };
const sheetsOf = () => ['STU', 'DATA'].flatMap(id => api.getSS(id).sheets);
function mentions(phoneTail, skip) {
  const hits = [];
  sheetsOf().forEach(sh => { if (skip.includes(sh.name)) return; for (let r = 2; r <= sh.getLastRow(); r++) for (let c = 1; c <= 30; c++) { const v = sh.get(r, c); if (v !== '' && v != null && String(v).replace(/\D/g, '').endsWith(phoneTail)) { hits.push(sh.name); return; } } });
  return [...new Set(hits)];
}
const step = (name, fn) => { try { fn(); } catch (e) { t(name + ' (threw)', false, e && e.stack); } };
const sends = from => api.fetches.slice(from).filter(f => /sendMessage$/.test(f.url));
const chatOf = f => String(f.body && f.body.chat_id);

step('1', () => {
  let r = post({ action: 'ping', token: TOKEN });
  t('1. teacher token: ping says teacher / math', r.ok && r.kind === 'teacher' && J(r.subjects) === '["math"]', J(r));
  r = post(Object.assign({ action: 'p4_session_scope' }, W.T));
  t('1. teacher session scope', r.ok && r.kind === 'teacher' && J(r.scope) === '["math"]', J(r));
  r = post(Object.assign({ action: 'p4_session_scope' }, W.A));
  t('1. scoped assistant session scope math + principal name', r.ok && J(r.scope) === '["math"]' && !!r.principal_name, J(r));
  r = post(Object.assign({ action: 'p4_session_scope' }, W.S1));
  t('1. plain student scope empty', r.ok && J(r.scope) === '[]', J(r));
  r = post(Object.assign({ action: 'p4_session_scope' }, W.owner));
  t('1. owner scope *', r.ok && J(r.scope) === '["*"]', J(r));
});
step('2', () => {
  const L = LESSONS.math;
  let r = post({ action: 'admin_set_written_models', token: TOKEN, lesson: L, models: [{ question_id: 'w1', max_marks: 3, model_answer: 'Because X', prompt: 'Why?' }] });
  t('2. teacher token sets written models on a math lesson', r.ok === true, J(r));
  r = post({ action: 'admin_set_video', token: TOKEN, lesson: L, slot: 'lesson', video_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ' });
  t('2. teacher token sets a math video', r.ok === true, J(r));
  const quiz = { title: 'Q', subject: 'math', lesson: L, questions: [{ id: 'q1', type: 'mcq', text: '1+1?', options: ['1', '2'], answer: 1 }] };
  r = post({ action: 'admin_set_quiz_content', token: TOKEN, lesson: L, content_json: JSON.stringify(quiz) });
  t('2. teacher token sets math quiz content', r.ok === true, J(r));
  r = post(T({ action: 'admin_set_lesson_lock', lesson: L, locked: true }));
  t('2. teacher session locks a math lesson', r.ok === true, J(r));
});
step('3', () => {
  const L = LESSONS.math, DATA = api.getSS('DATA');
  const WA = DATA.getSheetByName('WrittenAnswers') || (() => { const sh = DATA.insertSheet('WrittenAnswers'); sh.appendRow(['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at']); return sh; })();   // the real tab lives in the DATA book (_dataSs)
  const sid1 = W.S1.student_id, sid2 = W.S2.student_id;
  WA.appendRow(['SUB1', sid1, L, 'w1', 'fA1', '', '', '', '']);
  WA.appendRow(['SUB2', sid2, L, 'w1', 'fB1', '', '', '', '']);
  let r = post(T({ action: 'admin_grading_queue' }));
  const q = J(r);
  t('3. teacher grading queue shows his student only', r.ok && q.includes('SUB1') && !q.includes('SUB2'), q);
  r = post(T({ action: 'admin_grade_written', submission_id: 'SUB1', question_id: 'w1', awarded: 2, student: S1PHONE }));
  t('3. teacher grades his student', r.ok === true, J(r));
  r = post(T({ action: 'admin_grade_written', submission_id: 'SUB2', question_id: 'w1', awarded: 2, student: S2PHONE }));
  t('3. teacher cannot grade a student who is not his', NA(r), J(r));
});
step('4', () => {
  let r = post(T({ action: 'admin_list_payments' }));
  const s = J(r);
  t('4. teacher payment list has the math payment, not the programming one', r.ok && s.includes('PAY-MATH') && !s.includes('PAY-PROG'), s);
  r = post(T({ action: 'admin_decide_payment', payment_id: 'PAY-PROG', decision: 'approve' }));
  t('4. teacher cannot decide a programming payment', NA(r) && payStatus('PAY-PROG') === 'pending', J(r) + payStatus('PAY-PROG'));
  r = post(T({ action: 'admin_decide_payment', payment_id: 'PAY-MATH', decision: 'approve', scope: 'programming/test-course#ch1' }));
  t('4. a crafted scope override outside his subject is refused', NA(r) && payStatus('PAY-MATH') === 'pending', J(r) + payStatus('PAY-MATH'));
});
step('5', () => {
  const bad = [];
  fx.actions.filter(a => a.rule === 'TEAM' && a.needs.includes('L') && !a.resolve && a.fields.lesson).forEach(a => {
    ['teacher_tok', 'teacher_ses'].forEach(c => {
      const kind = c === 'teacher_tok' ? 'tok' : 'ses'; if (!a.via.includes(kind)) return;
      const p = Object.assign({ action: a.action }, W.callers[c](), { [a.fields.lesson]: LESSONS.programming });
      if (a.fields.student) p[a.fields.student.replace('[]', '')] = S1PHONE;
      if (a.fields.group) p[a.fields.group] = 'G-OWN';
      if (a.action === 'upload_attachment') p.subject = 'programming';
      const r = post(p); if (!NA(r)) bad.push(a.action + '/' + c + ' -> ' + J(r).slice(0, 80));
    });
  });
  t('5. every lesson-keyed admin action is refused for a programming lesson (token and session)', bad.length === 0, bad.join(' | '));
});
step('6', () => {
  api.addEnt(S1PHONE, 'math/test-course#ch1', '', 'manual'); api.addEnt(S1PHONE, 'programming/test-course#ch1', '', 'manual');
  const ov = J(post(O({ action: 'admin_access_overview' }))), tv = J(post(T({ action: 'admin_access_overview' })));
  t('6. owner sees both sides of the shared student', ov.includes('math/test-course') && ov.includes('programming/test-course'), ov.slice(0, 200));
  t('6. teacher sees only the math side of the shared student', tv.includes('math/test-course') && !tv.includes('programming/test-course'), tv.slice(0, 200));
});
step('7', () => {
  for (const a of ['admin_get_all', 'admin_list_groups', 'admin_access_overview', 'admin_followup_overview', 'admin_list_payments']) {
    const s = J(post(T({ action: a })));
    t('7. ' + a + ' for the teacher never mentions the foreign student', !s.includes(tail(S2PHONE)) && !s.includes('Foreign Student'), s.slice(0, 160));
  }
  let r = post(T({ action: 'admin_student_summary', student: S2PHONE }));
  t('7. summary of a foreign student is refused', NA(r), J(r));
  r = post(T({ action: 'admin_group_add', group: 'G-OWN', phone: S2PHONE }));
  const keys = Object.keys(r).sort().join();
  t('7. add-by-phone answers only registered true/false', r.ok === true && r.registered === true && keys === 'ok,registered', J(r));
  r = post(T({ action: 'admin_group_add', group: 'G-OWN', phone: '01099999998' }));
  t('7. unknown phone: registered false, nothing else', r.ok === true && r.registered === false && Object.keys(r).sort().join() === 'ok,registered', J(r));
  let refused = -1;
  for (let i = 0; i < 40; i++) { const x = post(T({ action: 'admin_group_add', group: 'G-OWN', phone: '0109999' + String(1000 + i) })); if (x.ok === false) { refused = i; break; } }
  t('7. the lookup bucket stops probing before 40 attempts (30 per hour, A4/A17)', refused > 0 && refused <= 35, refused);
});
step('8', () => {
  const o = J(post(O({ action: 'admin_get_all' })));
  t('8. owner still sees every student', o.includes(tail(S1PHONE)) && o.includes(tail(S2PHONE)), o.slice(0, 160));
  t('8. owner token still works on its own actions', post({ action: 'ping', token: 'tok' }).ok === true && post({ action: 'admin_list_videos', token: 'tok' }).ok !== false);
});
step('9', () => {
  const L0 = api.fetches.length;
  let r = post(T({ action: 'p4_tg_link_start' }));
  const m = /start=([A-Z2-9]{8})/.exec(String(r.link || ''));
  t('9. link start returns a t.me deep link with an 8-character code', r.ok && /t\.me\/test_bot\?start=/.test(r.link) && !!m && r.expires_in === 900, J(r));
  const code = m && m[1];
  tgPost({ update_id: 1, message: { message_id: 1, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: '/start ' + code } });
  t('9. /start <code> in a private chat links the teacher', post(T({ action: 'p4_tg_status' })).linked === true);
  tgPost({ update_id: 2, message: { message_id: 2, chat: { id: 556, type: 'group' }, from: { id: 556 }, text: '/start ' + code } });
  const rr = api.rows('TeacherTelegram');
  t('9. one TeacherTelegram row, for the private chat only; code is single use', rr.length === 1 && String(rr[0].chat_id) === '555', J(rr));
  const n0 = api.fetches.length;
  api.env.ctx._notifyAdmin('New payment PAY-MATH', 'PAY-MATH');
  let s = sends(n0);
  t('9. math payment pings the owner and the teacher, both with Approve/Reject buttons', s.some(f => chatOf(f) === '900') && s.some(f => chatOf(f) === '555' && /ap:PAY-MATH/.test(J(f.body.reply_markup))), s.map(chatOf).join());
  const n1 = api.fetches.length;
  api.env.ctx._notifyAdmin('New payment PAY-PROG', 'PAY-PROG');
  s = sends(n1);
  t('9. programming payment pings only the owner', s.length >= 1 && s.every(f => chatOf(f) === '900'), s.map(chatOf).join());
  const tap = (chat, data, id) => tgPost({ update_id: 100 + id, callback_query: { id: 'cb' + id, from: { id: chat }, data, message: { message_id: 9, chat: { id: chat, type: 'private' } } } });
  tap(555, 'ap:PAY-MATH', 1);
  t('9. teacher tap on a math payment approves it', /approved/i.test(payStatus('PAY-MATH')), payStatus('PAY-MATH'));
  const n2 = api.fetches.length;
  tap(555, 'ap:PAY-MATH', 2);
  t('9. a second tap answers "Already decided" and changes nothing', api.fetches.slice(n2).some(f => /Already decided/i.test(J(f.body))) && /approved/i.test(payStatus('PAY-MATH')), payStatus('PAY-MATH'));
  tap(555, 'ap:PAY-PROG', 3);
  t('9. forged callback for a programming payment is refused', payStatus('PAY-PROG') === 'pending', payStatus('PAY-PROG'));
  W.addPayment('PAY-MATH2', 'math/test-course'); W.addPayment('PAY-MATH3', 'math/test-course');
  tap(777, 'ap:PAY-MATH2', 4);
  t('9. a tap from an unregistered chat does nothing', payStatus('PAY-MATH2') === 'pending', payStatus('PAY-MATH2'));
  tap(900, 'ap:PAY-PROG', 5);
  t('9. the owner chat still decides anything', /approved/i.test(payStatus('PAY-PROG')), payStatus('PAY-PROG'));
  r = post(T({ action: 'p4_tg_unlink' }));
  t('9. teacher unlinks; no more pings', r.ok === true && post(T({ action: 'p4_tg_status' })).linked === false);
});
step('10', () => {
  const r = post(T({ action: 'admin_decide_payment', payment_id: 'PAY-MATH2', decision: 'approve' }));
  t('10. the same decision from his dashboard still works', r.ok === true && /approved/i.test(payStatus('PAY-MATH2')), J(r) + payStatus('PAY-MATH2'));
});
step('11', () => {
  const log0 = api.rows('StudentEditLog').length, n0 = api.fetches.length;
  let r = post(T({ action: 'p4_teacher_update_student', student: S1PHONE, changes: { name: 'Renamed Student', parent_phone: '01199999999' } }));
  t('11. name and parent phone edit accepted, only whitelisted fields returned', r.ok === true && r.student && r.student.name === 'Renamed Student' && Object.keys(r.student).sort().join() === 'name,parent_phone,phone', J(r));
  t('11. one log row per changed field; name-only change does not ping the owner', api.rows('StudentEditLog').length === log0 + 2 && sends(n0).length === 0, api.rows('StudentEditLog').length - log0);
  r = post(T({ action: 'p4_teacher_update_student', student: S1PHONE, changes: { is_admin: true } }));
  t('11. a field outside the whitelist refuses the whole request', r.ok === false, J(r));
  r = post(T({ action: 'p4_teacher_update_student', student: S2PHONE, changes: { name: 'Hacked' } }));
  t('11. a student who is not his is refused', NA(r), J(r));
  r = post(A({ action: 'p4_teacher_update_student', student: S1PHONE, changes: { name: 'x' } }));
  t('11. an assistant cannot edit records', NA(r), J(r));
  r = post(T({ action: 'p4_teacher_update_student', student: S1PHONE, changes: { phone: APHONE } }));
  t('11. a phone that is already registered gets the generic refusal', r.ok === false && r.error === 'Could not apply that change.', J(r));
  const before = mentions(tail(S1PHONE), ['StudentEditLog', 'TeacherTelegram']);
  const n1 = api.fetches.length;
  r = post(T({ action: 'p4_teacher_update_student', student: S1PHONE, changes: { phone: '01000000999' } }));
  t('11. phone change accepted', r.ok === true && r.student && tail(r.student.phone) === '1000000999', J(r));
  const after = mentions(tail(S1PHONE), ['StudentEditLog', 'TeacherTelegram']);
  t('11. no phone-keyed sheet still holds the old phone (was in: ' + before.join('/') + ')', before.length >= 3 && after.length === 0, after.join());
  t('11. the new phone is in every sheet that held the old one', before.every(n => mentions('1000000999', []).includes(n)), before.join());
  t('11. the owner got a Telegram ping for the phone change', sends(n1).some(f => chatOf(f) === '900' && /1000000999/.test(f.body.text)), J(sends(n1).map(f => f.body.text)));
  t('11. the log kept old and new phone', api.rows('StudentEditLog').some(x => String(x.field) === 'phone' && /1000000999/.test(String(x.new_value))));
  r = post(Object.assign({ action: 'login_student', phone: '01000000999', password_hash: api.H('pw') }));
  t('11. the student can log in with the new phone', r.ok === true, J(r));
});
step('12', () => {
  if (typeof api.env.ctx.p4_resetCache_ === 'function') api.env.ctx.p4_resetCache_();   // the harness keeps globals across requests; real Apps Script starts every request fresh
  Object.keys(api.env.cache).forEach(k => { if (/^p4lk:/.test(k)) delete api.env.cache[k]; });   // step 7 spent the shared lookup bucket (A17); a fresh hour for step 12
  api.env.ctx.__noop = 0;
  // step 7 legitimately made S2 one of his students (add-by-phone into his group), so step 12 needs a real stranger
  const STR = post({ action: 'register_student', phone: '01000000555', password_hash: api.H('pw'), display_name: 'Stranger', year: 'Senior 2', parent_phone: '01234567890' });
  api.getSS('DATA').getSheetByName('WrittenAnswers').appendRow(['SUB3', STR.student_id, LESSONS.math, 'w1', 'fC1', '', '', '', '']);
  const reg = post({ action: 'register_student', phone: '01000000104', password_hash: api.H('pw'), display_name: 'Helper', year: 'Senior 2', parent_phone: '01234567890' });
  let r = post(T({ action: 'p4_teacher_set_assistant', phone: '01000000104' }));
  t('12. appointing answers only registered true/false', r.ok === true && r.registered === true && Object.keys(r).sort().join() === 'ok,registered', J(r));
  r = post(T({ action: 'p4_teacher_list_assistants' }));
  t('12. his assistant list contains the new assistant and the earlier one, not the legacy one', r.ok && J(r).includes('Helper') && J(r).includes(tail(APHONE)) && !J(r).includes(tail(LPHONE)), J(r));
  const asst = { student_id: reg.student_id, session_token: reg.session_token };
  const as = o => Object.assign({}, asst, o);
  t('12. assistant cannot decide payments', NA(post(as({ action: 'admin_decide_payment', payment_id: 'PAY-MATH3', decision: 'approve' }))));
  t('12. assistant cannot list payments', NA(post(as({ action: 'admin_list_payments' }))));
  t('12. assistant cannot appoint or edit', NA(post(as({ action: 'p4_teacher_set_assistant', phone: '01000000105' }))) && NA(post(as({ action: 'p4_teacher_update_student', student: S1PHONE, changes: { name: 'x' } }))));
  { const rs = post(as({ action: 'admin_student_summary', student: '01000000999' })); t('12. assistant sees his teacher\'s student summary', rs.ok === true, J(rs)); }
  t('12. assistant cannot see a foreign student', NA(post(as({ action: 'admin_student_summary', student: '01000000555' }))));
  const gq = J(post(as({ action: 'admin_grading_queue' })));
  t('12. assistant grading queue has no foreign rows', !gq.includes('SUB3'), gq.slice(0, 160));
  t('12. legacy owner assistant is unchanged (still unscoped)', post(Object.assign({ action: 'admin_student_summary', student: S2PHONE }, LS)).ok === true);
  r = post(O({ action: 'p4_admin_set_teacher', phone: TPHONE, scope: '' }));
  t('12. owner removes the teacher scope', r.ok === true, J(r));
  t('12. his assistants are locked out at once', NA(post(as({ action: 'admin_student_summary', student: '01000000999' }))) && NA(post(Object.assign({ action: 'admin_student_summary', student: '01000000999' }, AS))));
  post(O({ action: 'p4_admin_set_teacher', phone: TPHONE, scope: 'math' }));
  post(T({ action: 'p4_teacher_set_assistant', phone: '01000000104' }));   // removing the scope reset his assistants (6c); appoint again to test revoke
  r = post(T({ action: 'p4_teacher_revoke_assistant', phone: '01000000104' }));
  t('12. teacher revokes his assistant', r.ok === true && NA(post(as({ action: 'admin_student_summary', student: '01000000999' }))), J(r));
  t('12. the teacher cannot revoke an assistant that is not his', NA(post(T({ action: 'p4_teacher_revoke_assistant', phone: LPHONE }))));
});
step('15', () => {
  t('15. teacher refused', NA(post(T({ action: 'p4_admin_teacher_stats' }))));
  t('15. scoped assistant refused', NA(post(A({ action: 'p4_admin_teacher_stats' }))));
  let r = post(O({ action: 'p4_admin_teacher_stats', refresh: true }));
  const s = J(r);
  t('15. owner gets stats with a block for the math teacher', r.ok === true && Array.isArray(r.teachers) && r.teachers.some(x => J(x.scope).includes('math')), s.slice(0, 200));
  t('15. no student name, phone, or payment reference anywhere in the response', !/Owned Student|Renamed Student|Foreign Student|ref-PAY/.test(s) && !s.includes(tail(S2PHONE)) && !s.includes('1000000999') && !s.includes(tail(S1PHONE)), s.slice(0, 200));
  r = post(O({ action: 'p4_admin_teacher_stats' }));
  t('15. second call is served from the cache', r.ok === true && r.cached === true, J({ cached: r.cached }));
});
console.log('NOTE steps 13 and 14 (Save button, unchanged owner dashboards) are browser behaviour: see test_p4_s7_*.');
process.exit(fails ? 1 : 0);
