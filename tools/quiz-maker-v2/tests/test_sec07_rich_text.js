// R-SEC07: question text written by staff can carry formatting (<code>, <b>, <br> ...) but never script.
//   node tests/test_sec07_rich_text.js apps_script/Code.gs      (run from tools/quiz-maker-v2)
// Part 1 (always): the server keeps only bare allow-listed tags when a quiz is saved (admin_set_quiz_content).
// Part 2 (jsdom): the pages' safeHtml() in quiz.js and assign.js rebuilds the text from fresh elements, so no
// attribute, handler, script, frame or image survives; both copies are identical and el() has no raw-HTML key.
const fs = require('fs'), path = require('path');
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<svg onload=alert(1)><circle/></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<b onclick="alert(1)">bold</b>',
  '<scr<script>ipt>alert(1)</script>',
  '<img src=x onerror=alert(1)',
  '<style>body{display:none}</style>',
  '<!-- <img src=x onerror=alert(1)> -->',
  '<details open ontoggle=alert(1)>x</details>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
];
const NASTY = /<(?!\/?(b|strong|i|em|u|s|code|pre|kbd|sub|sup|br|p|span|small|mark|ul|ol|li|blockquote)>)[a-z!\/?]/i;

// ---------------------------------------------------------------- part 1: server
const codeGs = process.argv[2] || 'apps_script/Code.gs';
const env = load(codeGs);
const { post, ctx } = env;

t('kept: <code>, <b>, <br>, entities and math text',
  ctx._safeRichText('What does <code>def</code> do? <b>Hint</b><br>\\(x \\lt 3\\) &amp; more') ===
  'What does <code>def</code> do? <b>Hint</b><br>\\(x \\lt 3\\) &amp; more');
t('attributes are dropped from allowed tags', ctx._safeRichText('<b onclick="alert(1)" class=x>bold</b>') === '<b>bold</b>',
  ctx._safeRichText('<b onclick="alert(1)" class=x>bold</b>'));
t('plain text with a lone < is left readable', ctx._safeRichText('3 < 5 and 7 > 2') === '3 < 5 and 7 > 2');
HOSTILE.forEach(h => {
  const out = ctx._safeRichText('Q ' + h + ' end');
  t('server: nothing that can start a tag survives: ' + h.slice(0, 40), !NASTY.test(out) && !/on\w+\s*=/i.test(out.replace(/[^<]*$/, '')) && !/<script|<img|<svg|<iframe|<a /i.test(out), out);
});

const quiz = { subject: 'programming', lesson: 'programming/x/l1', title: 'T', questions: [
  { type: 'mcq', q: 'Pick <img src=x onerror=alert(1)><code>def</code>', options: ['<b>a</b>', 'b'], correct: [0] },
  { type: 'truefalse', prompt: '<script>steal()</script>True?', correct: true },
  { type: 'match', prompt: 'Match <svg onload=alert(1)></svg>', rows: [{ label: '<i>x</i>', answer: 'y' }], options: ['y'] },
] };
let r = post({ action: 'admin_set_quiz_content', token: 'tok', lesson: 'programming/x/l1', content_json: JSON.stringify(quiz) });
t('admin_set_quiz_content saves', r.ok, JSON.stringify(r));
r = post({ action: 'admin_get_quiz_content', token: 'tok', lesson: 'programming/x/l1' });
const qs = r.quiz && r.quiz.questions;
t('stored MCQ text is clean, formatting kept', qs && qs[0].q === 'Pick <code>def</code>', qs && qs[0].q);
t('stored true/false text is clean', qs && qs[1].prompt === 'True?', qs && qs[1].prompt);
t('stored match text is clean', qs && qs[2].prompt === 'Match ', qs && qs[2].prompt);
t('options and rows are not touched (the pages show them as text)', qs && qs[0].options[0] === '<b>a</b>' && qs[2].rows[0].label === '<i>x</i>');
const plain = { title: 'T', questions: [{ type: 'mcq', q: 'What does <code>def</code> do?', options: ['a', 'b'], correct: [0] }] };
const plainJson = JSON.stringify(plain, null, 1);
post({ action: 'admin_set_quiz_content', token: 'tok', lesson: 'programming/x/l2', content_json: plainJson });
t('a clean quiz is stored exactly as sent', ctx._lookupQuizContent(ctx._lessonPath('programming/x/l2')) === plainJson);
r = post({ action: 'admin_set_quiz_content', token: 'tok', lesson: 'programming/x/l3', content_json: '{bad' });
t('malformed JSON is still refused', !r.ok);

// ---------------------------------------------------------------- part 2: pages
const SITE = path.resolve(__dirname, '..', '..', '..');
const files = ['assets/quiz.js', 'assets/assign.js', 'tools/quiz-maker-v2/assets_templates/quiz.js', 'tools/quiz-maker-v2/assets_templates/assign.js'];
const srcs = files.map(f => fs.readFileSync(path.join(SITE, f), 'utf8').replace(/\r\n/g, '\n'));
const grab = s => { const a = s.indexOf('  var SAFE_TAGS'), b = s.indexOf('\n  function el(', a); return a >= 0 && b > a ? s.slice(a, b) : null; };
const fns = srcs.map(grab);
t('safeHtml() is present in every engine copy', fns.every(Boolean), files.filter((f, i) => !fns[i]).join(', '));
t('safeHtml() is identical in quiz.js and assign.js (and their templates)', fns.every(f => f === fns[0]));
srcs.forEach((s, i) => {
  t(files[i] + ': el() has no raw-HTML key', !/k === "html"/.test(s) && !/[{,]\s*html:/.test(s));
  t(files[i] + ': question text goes through rich', /class: "qz-question", rich: /.test(s));
});

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
if (!JSDOM) {
  console.log('SKIP page part: jsdom is not installed (npm ci). The server part above ran.');
} else if (fns[0]) {
  const dom = new JSDOM('<!doctype html><body><div id=h></div></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.__ran = 0;
  w.alert = () => { w.__ran++; };
  w.eval(fns[0] + '\nwindow.safeHtml = safeHtml;');
  const render = html => { const h = w.document.getElementById('h'); h.textContent = ''; h.appendChild(w.safeHtml(html)); return h; };
  let h = render('What does <code>def</code> do? <b>yes</b><br><sub>2</sub>');
  t('page: formatting tags are kept', h.innerHTML === 'What does <code>def</code> do? <b>yes</b><br><sub>2</sub>', h.innerHTML);
  HOSTILE.forEach(x => {
    h = render('Q ' + x + ' end');
    const bad = h.querySelector('img,script,svg,iframe,a,style,details,math,object,embed');
    const attrs = [...h.querySelectorAll('*')].some(e => e.attributes.length);
    t('page: inert and attribute-free: ' + x.slice(0, 40), !bad && !attrs, h.innerHTML);
  });
  h = render('5 &lt; 6 and 3 < 4');
  t('page: entities and a lone < read as text', h.textContent === '5 < 6 and 3 < 4', h.textContent);
  t('page: nothing ran', w.__ran === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
