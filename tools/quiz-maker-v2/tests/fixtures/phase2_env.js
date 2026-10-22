// Shared fixture for the Phase 2 regression tests (Session 5).
// Builds a fresh backend (the real Code.gs + every Phase2_*.gs) with an admin, a few students,
// the three renamed Senior 2 lessons from the rollout plan (old keys, typo key, new keys) and
// helpers that write to the sheets the same way the existing tests do.
const path = require('path'), crypto = require('crypto');
const { load } = require('../harness');
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const APPS = path.join(__dirname, '..', '..', 'apps_script');
const G2 = 'programming/baccalaureate/grade-2-secondary/';
// [old folder, typo?, new folder]  (plan 1.1)
const LESSONS = {
  L1: { old: G2 + 'lesson-1-development-of-information-technology-and-social-transformation', now: G2 + 'chapter-1-lesson-1-development-of-information-technology-and-social-transformation' },
  L2: { old: G2 + 'lesson-2-how-ai-works', now: G2 + 'chapter-1-lesson-2-how-ai-works' },
  L3: { old: G2 + 'chaper-1-lesson-3-ai-in-daily-life-and-industry', now: G2 + 'chapter-1-lesson-3-ai-in-daily-life-and-industry' },
  L4: { old: G2 + 'chapter-1-lesson-4-ethical-issues-with-ai', now: G2 + 'chapter-1-lesson-4-ethical-issues-with-ai' },   // never renamed
};
const bare = k => k.split('/').pop();

function makeEnv(opts = {}) {
  const env = load(path.join(APPS, 'Code.gs'), Object.assign({ clock: true }, opts));
  const { post, getSS } = env;
  const tab = n => getSS('STU').getSheetByName(n);
  const ensure = (name, headers) => { let sh = tab(name); if (!sh) { sh = getSS('STU').insertSheet(name); sh.appendRow(headers); } return sh; };
  const colOf = (sh, name) => { for (let c = 1; c <= 30; c++) if (sh.get(1, c) === name) return c; return 0; };
  const rows = n => { const sh = tab(n); if (!sh) return []; const o = []; for (let r = 2; r <= sh.getLastRow(); r++) { const row = {}; for (let c = 1; c <= 30; c++) if (sh.get(1, c)) row[sh.get(1, c)] = sh.get(r, c); o.push(row); } return o; };
  const reg = (phone, pw, name, year, parent) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: year || 'Senior 2', parent_phone: parent || '01100000009' });
  const adm = reg('01000000001', 'a', 'Teacher', 'Senior 2');
  const stu = tab('Students'); stu.set(2, colOf(stu, 'is_admin'), true);
  const people = {};
  [['sara', '01000000002', 'Sara Mahmoud'], ['omar', '01000000003', 'Omar Ali'], ['lamis', '01000000004', 'Lamis Adel'], ['hana', '01000000005', 'Hana Sami']].forEach(([k, ph, nm]) => {
    const r = reg(ph, k, nm, 'Senior 2', '012345678' + ph.slice(-2)); people[k] = { phone: ph, creds: { student_id: r.student_id, session_token: r.session_token } };
  });
  const api = {
    env, post, getSS, tab, ensure, colOf, rows, H, LESSONS, G2, bare,
    TOK: { token: 'tok' }, ADMIN: { student_id: adm.student_id, session_token: adm.session_token },
    P: k => people[k].phone, S: k => people[k].creds, short: k => people[k].phone.slice(-10),
    addEnt: (phone, scope, expires, source) => ensure('Entitlements', ['phone', 'scope', 'expires_at', 'granted_at', 'source']).appendRow([phone, scope, expires || '', '2026-10-01 00:00:00', source || '']),
    addQuizAccess: (phone, lesson, expires, source) => ensure('QuizAccess', ['phone', 'lesson', 'expires_at', 'granted_at', 'source']).appendRow([phone, lesson, expires || '', '2026-10-01 00:00:00', source || '']),
    setVideo: (lesson, id, locked) => post({ action: 'admin_set_video', token: 'tok', lesson, slot: 'lesson', video_url: 'https://www.youtube.com/embed/' + id, locked }),
    group: (name, phones) => phones.forEach(p => post({ action: 'admin_group_add', token: 'tok', group: name, phone: p })),
    saveGroup: body => post(Object.assign({ action: 'admin_followup_save_group', token: 'tok' }, body)),
    overview: () => post({ action: 'admin_followup_overview', token: 'tok' }),
    quiz: (who, lesson, score, id, start) => post({ action: 'upload_quiz_result', student_id: people[who].phone, name: who, subject: 'programming', lesson, quiz_title: 'Q', start_time: start || '2026-10-20T10:00:00Z', end_time: start || '2026-10-20T10:05:00Z', score, total: 10, questions: [], client_id: id }),
    watch: (who, lesson) => post({ action: 'get_video', lesson, slot: 'lesson', student_id: people[who].phone, session_token: people[who].creds.session_token }),
  };
  api.people = people;
  return api;
}
module.exports = { makeEnv, LESSONS, G2, bare };
