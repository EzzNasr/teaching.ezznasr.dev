// R-P25-G-BULK: the browser's bulk-paste parser (assets/bulk-parse.js, used by dashboard/my-lessons.html) gives exactly
// the questions the desktop Quiz Maker makes (parse_bulk_graded_questions in modules/common.py), on the same blocks:
// multiple choice (stars, select-all, math with stars inside, escaped star), true/false, matching, written (marks,
// model on several lines), Ch: lines, --- separators, Windows line ends, Arabic text and junk. Written question ids are
// random on both sides and are compared by shape only. The AI instructions name the lesson and every keyword, and the
// examples inside them parse to one question of each kind.
//   node tests/test_p25_bulk_parse.js        (run from tools/quiz-maker-v2; needs python)
const path = require('path');
const { spawnSync } = require('child_process');
const B = require(path.join(__dirname, '..', '..', '..', 'assets', 'bulk-parse.js'));
let fails = 0, passes = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 600))); ok ? passes++ : fails++; };

const CASES = [
  ['multiple choice, one answer', 'Q: What does def do?\nA) Deletes\nB) Starts a function *\nC) Classes\nE: def starts a function.', 1],
  ['select all that apply', 'Q: Which are gases?\nA) Oxygen *\nB) Iron\nC) Helium *', null],
  ['no star = first option', 'Q: Pick\nA) one\nB) two', 3],
  ['math with a star inside, escaped star, real star', 'Q: Which is \\(x^*\\)?\nA) \\(a*b\\)\nB) five \\*\nC) the conjugate \\(z^*\\) *\nD) \\(open*', null],
  ['true / false', 'TF: Python is compiled.\nCorrect: False\nE: interpreted\n\nTF: Ice floats.\nCorrect: true', null],
  ['true / false without an answer is dropped', 'TF: no answer here', null],
  ['matching', 'MATCH: Match them\n- Variable -> Stores a value\n- Loop -> Repeats code\n- Zed -> Apple\nE: ok', 2],
  ['matching with one row is dropped', 'MATCH: too small\n- a -> b', null],
  ['written', 'WRITTEN: Explain lists.\nMarks: 4\nModel: A list is mutable,\na tuple is not.\nE: see notes\nmore notes', null],
  ['written short keys, bad marks', 'W: Why?\nMax: 500\nModel: because', null],
  ['written then a new question', 'WRITTEN: First\nsecond line\nQ: Next\nA) x *\nB) y', null],
  ['chapters and separators', 'Q: one\nA) a *\nB) b\n---\nCh: 3\nTF: two\nCorrect: True\nCh: 4\nMATCH: m\n- a -> b\n- c -> d', 1],
  ['Windows line ends', 'Q: crlf\r\nA) yes *\r\nB) no\r\n\r\nTF: t\r\nCorrect: False', null],
  ['Arabic', 'Q: ما هي حالة المادة الثابتة الشكل؟\nA) صلبة *\nB) سائلة\nC) غازية\nE: الصلبة شكلها ثابت.', 2],
  ['lower-case options and F option', 'Q: six\na) 1\nb) 2\nc) 3\nd) 4\ne) 5 *\nf) 6', null],
  ['junk and empty', 'hello\nworld\n\n   \n', null],
  ['empty', '', null],
];

const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..'))})
from modules.common import parse_bulk_graded_questions
cases = json.loads(sys.stdin.read())
print(json.dumps([parse_bulk_graded_questions(t, ch) for _n, t, ch in cases], ensure_ascii=False))
`;
const r = spawnSync('python', ['-c', py], { input: JSON.stringify(CASES), encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
if (r.status !== 0) { console.log('FAIL the Python parser ran  ' + r.stderr.slice(0, 600)); process.exit(1); }
const want = JSON.parse(r.stdout);
const norm = items => JSON.stringify(items.map(q => (q.type === 'written' ? Object.assign({}, q, { qid: /^w[0-9a-f]{8}$/.test(q.qid) ? 'w########' : 'BAD:' + q.qid }) : q)));
CASES.forEach(([name, text, ch], i) => {
  const got = norm(B.parse(text, ch)), exp = norm(want[i]);
  t('same as the Quiz Maker: ' + name, got === exp, 'js ' + got + '\n   py ' + exp);
});

const ins = B.instructions({ title: 'Chapter 1 Lesson 1 | Matter', course: 'Science · 1st Secondary' });
t('instructions name the lesson', ins.indexOf('"Chapter 1 Lesson 1 | Matter" (Science · 1st Secondary)') > 0);
t('instructions cover every keyword', ['Q:', 'A)', 'TF:', 'Correct:', 'MATCH:', 'WRITTEN:', 'Marks:', 'Model:', 'E:', 'Ch:'].every(k => ins.indexOf(k) !== -1));
const ex = B.parse(ins.split('\n').filter(l => /^(Q:|[A-F]\)|TF:|Correct:|MATCH:|- .* -> |WRITTEN:|Marks:|Model:|E: )/.test(l) || l === '').join('\n'), null);
t('the examples in the instructions parse to one question of each kind', JSON.stringify(ex.map(q => q.type)) === JSON.stringify(['mcq', 'truefalse', 'match', 'written']), JSON.stringify(ex.map(q => q.type)));
t('instructions without a lesson still read well', B.instructions().indexOf('Write quiz questions for my lesson.') === 0);

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
