// R-P25-C: the "science" subject (Phase 2.5 step C).
//   node tests/test_p25_science.js        (run from tools/quiz-maker-v2)
// Backend: the owner can make a teacher for science; his session, token and assistant are scoped to science like any
// other subject; he works on science lessons and is refused on math / programming; a science teacher appears in the
// stats; all three subject lists agree.
// Site: science/ has the two grade pages (3rd Prep, 1st Secondary), every link resolves, no subscription widget, the
// home card says "Math" (no longer "Math — SAT / EST").
const fs = require('fs'), path = require('path');
const { makeWorld, setStudent, colEnsure, sha256 } = require('./test_p4_s4_support');
let fails = 0, passes = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 400))); ok ? passes++ : fails++; };
const J = o => JSON.stringify(o);
const NA = r => !!r && r.ok === false && r.error === 'Not authorized.';
const SITE = path.resolve(__dirname, '..', '..', '..');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8');

// ---------------------------------------------------------------- backend
const lists = ['P4_SUBJECTS', 'P4T_SUBJECTS', 'P4S_SUBJECTS'].map(n => (CODE.match(new RegExp('^var ' + n + ' = (\\[[^\\]]*\\]);', 'm')) || [])[1]);
t('the three backend subject lists exist and are identical', lists.every(Boolean) && lists.every(l => l === lists[0]), lists.join(' | '));
t('science is a backend subject', JSON.parse(lists[0] || '[]').includes('science'));

const W = makeWorld({});
const { api, post } = W;
const SCI = 'science/secondary/grade-1-secondary/lesson-1', PREP = 'science/preparatory/grade-3-preparatory/lesson-1';
const SPHONE = '01000000131', TOK = 'scienceTok';
const reg = post({ action: 'register_student', phone: SPHONE, password_hash: api.H('pw12345678'), display_name: 'Science Teacher', year: 'Senior 1', parent_phone: '01234567892' });
t('science teacher registers', reg.ok, J(reg));
let r = post(Object.assign({ action: 'p4_admin_set_teacher', phone: SPHONE, scope: 'science' }, W.owner));
t('the owner makes him a science teacher', r.ok && r.role === 'teacher' && r.scope === 'science', J(r));
const S = { student_id: reg.student_id, session_token: reg.session_token };
r = post(Object.assign({ action: 'p4_session_scope' }, S));
t('his session is scoped to science', r.ok && r.kind === 'teacher' && J(r.scope) === '["science"]', J(r));
const toks = JSON.parse(api.env.props.P4_TEACHER_TOKENS || '{}');
toks[sha256(TOK)] = { name: 'Science Teacher', scope: 'science', created: '2026-11-23T00:00:00Z' };
api.env.props.P4_TEACHER_TOKENS = JSON.stringify(toks);
r = post({ action: 'ping', token: TOK });
t('his desktop token is scoped to science', r.ok && r.kind === 'teacher' && J(r.subjects) === '["science"]', J(r));
[SCI, PREP].forEach(L => {
  r = post({ action: 'admin_set_video', token: TOK, lesson: L, slot: 'lesson', video_url: 'https://www.youtube.com/embed/sssssssssss' });
  t('he sets a video on ' + L, r.ok === true, J(r));
  r = post({ action: 'admin_set_quiz_content', token: TOK, lesson: L, content_json: J({ title: 'Q', questions: [{ type: 'mcq', q: 'H2O?', options: ['water', 'salt'], correct: [0] }] }) });
  t('he saves quiz content on ' + L, r.ok === true, J(r));
  r = post(Object.assign({ action: 'admin_set_lesson_lock', lesson: L, locked: true }, S));
  t('his session locks ' + L, r.ok === true, J(r));
});
['math/test-course/lesson-1', 'programming/test-course/lesson-1', 'english/x/lesson-1', 'sciencex/a/b'].forEach(L => {
  t('he is refused on ' + L, NA(post({ action: 'admin_set_video', token: TOK, lesson: L, slot: 'lesson', video_url: 'https://www.youtube.com/embed/sssssssssss' })) &&
    NA(post(Object.assign({ action: 'admin_set_lesson_lock', lesson: L, locked: true }, S))));
});
t('the math teacher is refused on science', NA(post({ action: 'admin_set_video', token: W.token, lesson: SCI, slot: 'lesson', video_url: 'https://www.youtube.com/embed/sssssssssss' })));
r = post(Object.assign({ action: 'admin_list_videos' }, S));
t('his video list holds only science', r.ok && J(r).includes('science/') && !J(r).includes('math/'), J(r).slice(0, 300));
r = post(Object.assign({ action: 'p4_admin_list_teachers' }, W.owner));
t('the owner sees him in the teacher list with scope science', r.ok && J(r).includes('science'), J(r).slice(0, 300));
r = post(Object.assign({ action: 'p4_admin_set_teacher', phone: SPHONE, scope: 'chemistry' }, W.owner));
t('an unknown subject is still refused, and the message lists science', !r.ok && /science/.test(r.error || ''), J(r));

// ---------------------------------------------------------------- site
const read = p => fs.readFileSync(path.join(SITE, p), 'utf8');
const exists = p => fs.existsSync(path.join(SITE, p));
const GRADES = ['science/preparatory/grade-3-preparatory', 'science/secondary/grade-1-secondary'];
t('science/index.html exists', exists('science/index.html'));
const portal = exists('science/index.html') ? read('science/index.html') : '';
GRADES.forEach(g => {
  t(g + ': page and style exist', exists(g + '/index.html') && exists(g + '/style.css'));
  t('the science page links to ' + g, portal.includes('href="./' + g.slice('science/'.length) + '/"'));
  const s = exists(g + '/index.html') ? read(g + '/index.html') : '';
  t(g + ': empty lesson grid the Quiz Maker can fill', /<div class="lessons">\s*<p class="empty">[^<]*<\/p>\s*<\/div>\s*<\/div>\s*<\/section>/.test(s));
  t(g + ': no chapter/term subscription widget (programming only)', !/subscribe\.js|id="subscriptions"/.test(s));
  t(g + ': SEO block stamped', s.includes('<!-- SEO:START') && s.includes('<link rel="canonical" href="https://teaching.ezznasr.dev/' + g + '/">'));
  t(g + ': in the sitemap', read('sitemap.xml').includes('https://teaching.ezznasr.dev/' + g + '/'));
});
t('the two cards say 3rd Prep and 1st Secondary', portal.includes('الصف الثالث الإعدادي') && portal.includes('الصف الأول الثانوي') && /Integrated Science/.test(portal));
const hrefs = [...portal.matchAll(/href="(\.\/[^"#]*)"/g)].map(m => m[1]);
t('every relative link on the science page resolves', hrefs.length >= 2 && hrefs.every(h => exists(path.join('science', h, h.endsWith('/') ? 'index.html' : ''))), hrefs.join(', '));
const home = read('index.html');
t('home card says "Math", no longer "Math — SAT / EST"', /<h3>Math<\/h3>/.test(home) && !/Math — SAT \/ EST/.test(home));
t('math page title is plain "Math Lessons and Practice"', /<title>Math Lessons and Practice \|/.test(read('math/index.html')));
['assets/dash-review.js', 'dashboard/master.html', 'dashboard/student.html', 'dashboard/team.html'].forEach(f => t(f + ' has a science label', /science: "/.test(read(f))));

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
