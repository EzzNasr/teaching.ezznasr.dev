// R-025  dashboard/access.html merges old/typo'd lesson keys into the current lesson (one row, not two).
// Pulls loadAliases/canonKey/canonOverview straight out of the page and runs them on sample data.
// Usage: node tests/test_access_alias_client.js [site root]
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const html = fs.readFileSync(path.join(root, 'dashboard', 'access.html'), 'utf8');
const aliases = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'lesson-aliases.json'), 'utf8'));
const start = html.indexOf('var ALIASES = null;'), end = html.indexOf('function load(quiet)');
t('alias block present in access.html', start > 0 && end > start);
const G2 = 'programming/baccalaureate/grade-2-secondary/';
const OLD = G2 + 'chaper-1-lesson-3-ai-in-daily-life-and-industry', NEW = G2 + 'chapter-1-lesson-3-ai-in-daily-life-and-industry';
const ctx = vm.createContext({ fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(aliases))) }), Promise, Object, String });
vm.runInContext(html.slice(start, end), ctx);
(async () => {
  await vm.runInContext('loadAliases()', ctx);
  const d = vm.runInContext('canonOverview', ctx)({
    access: [{ scope: OLD, phone: '1' }, { scope: NEW, phone: '2' }, { scope: G2 + '*', phone: '3' }, { scope: '*', phone: '4' }],
    quizzes: [{ lesson: OLD, locked: false }, { lesson: NEW, locked: true }],
    videos: [{ lesson: OLD, slot: 'a' }, { lesson: NEW, slot: 'b' }],
    lesson_locks: [{ lesson: OLD }, { lesson: NEW }],
    all_lessons: [{ lesson: OLD }, { lesson: NEW }, { lesson: 'english/ace-the-interview' }],
  });
  t('grants under the typo key become the current key', d.access[0].scope === NEW);
  t('grants stay two people (no rows lost)', d.access.length === 4);
  t('wildcard and "*" scopes are untouched', d.access[2].scope === G2 + '*' && d.access[3].scope === '*');
  t('typo + current quiz collapse into one', d.quizzes.length === 1 && d.quizzes[0].lesson === NEW);
  t('typo + current lesson lock collapse into one', d.lesson_locks.length === 1);
  t('lesson list has no second copy', d.all_lessons.filter(l => l.lesson === NEW).length === 1 && d.all_lessons.length === 2);
  t('videos keep both slots, both under the current key', d.videos.length === 2 && d.videos.every(v => v.lesson === NEW));
  t('no "chaper" key survives anywhere', !JSON.stringify(d).includes('chaper'));
  // alias file missing -> page still works, keys unchanged
  const c2 = vm.createContext({ fetch: () => Promise.reject(new Error('offline')), Promise, Object, String });
  vm.runInContext(html.slice(start, end), c2);
  await vm.runInContext('loadAliases()', c2);
  t('alias file unreachable: keys pass through unchanged', vm.runInContext('canonKey', c2)(OLD) === OLD);
  console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})();
