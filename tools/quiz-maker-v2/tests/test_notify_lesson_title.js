// Telegram "Quiz completed": the lesson name must appear once (owner bug report 2026-11-03: the path name, then
// an em dash, then the quiz title repeating the same lesson). node tests/test_notify_lesson_title.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8');
const pick = n => { const i = src.indexOf('function ' + n + '('); let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
const sent = [];
const ctx = vm.createContext({ console, sent });
vm.runInContext([pick('_esc'), pick('_prettyLesson'), pick('_autoScoreLine'), pick('_writtenLine'), pick('_lessonWithTitle_'), pick('_notifyQuiz'),
  'function _notifyAdmin(m){ sent.push(m); }'].join('\n'), ctx);
let pass = 0, fail = 0; const t = (n, ok, d) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  -> ' + JSON.stringify(d))); };
const P = 'programming/baccalaureate/grade-2-secondary/chapter-2-lesson-3-incident-response-and-risk-management';
ctx._notifyQuiz({ name: 'Ali', lesson_path: P, quiz_title: 'Chapter 2 Lesson 3 | Incident Response and Risk Management', score: 8, total: 10 }, { ok: true });
const m = sent.pop() || '';
t('quiz message names the lesson once', (m.match(/Incident Response/gi) || []).length === 1, m);
t('no em dash before a repeated title', m.indexOf('—') === -1, m);
t('grade still shown, title wording kept', /Grade 2 Secondary › Chapter 2 Lesson 3 \| Incident Response and Risk Management/.test(m), m);
t('score still shown', /8\/10/.test(m), m);
ctx._notifyQuiz({ name: 'Ali', lesson_path: P, quiz_title: 'Midterm review', score: 1, total: 2 }, { ok: true });
const m2 = sent.pop() || '';
t('a different title is still added after the lesson', /Risk Management — Midterm review/.test(m2), m2);
ctx._notifyQuiz({ name: 'Ali', lesson_path: P }, { ok: true });
t('no title: lesson only', (sent.pop() || '').indexOf('—') === -1);
t('chapter-only title is not duplicated', ctx._lessonWithTitle_('Grade 2 Secondary › Chapter 2 Lesson 3 Incident Response', 'Chapter 2 Lesson 3').split('Chapter 2').length === 2);
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
