// R-001b  assets/lesson-aliases.json and Phase2_Keys.gs (P2_LESSON_ALIASES, p2k_canon) agree, and the
// three renames from rollout plan 1.1 are present, in full-path and bare-slug form.
// Fails (pending:S1) until Session 1 delivers both files.   Usage: node tests/test_R001b_alias_sync.js [site root]
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const G2 = 'programming/baccalaureate/grade-2-secondary/';
const MUST = {   // old -> canonical (plan 3.1)
  [G2 + 'lesson-1-development-of-information-technology-and-social-transformation']: G2 + 'chapter-1-lesson-1-development-of-information-technology-and-social-transformation',
  [G2 + 'lesson-2-how-ai-works']: G2 + 'chapter-1-lesson-2-how-ai-works',
  [G2 + 'chaper-1-lesson-3-ai-in-daily-life-and-industry']: G2 + 'chapter-1-lesson-3-ai-in-daily-life-and-industry',
  'lesson-1-development-of-information-technology-and-social-transformation': G2 + 'chapter-1-lesson-1-development-of-information-technology-and-social-transformation',
  'lesson-2-how-ai-works': G2 + 'chapter-1-lesson-2-how-ai-works',
  'chaper-1-lesson-3-ai-in-daily-life-and-industry': G2 + 'chapter-1-lesson-3-ai-in-daily-life-and-industry',
};
const gsDir = path.join(root, 'tools', 'quiz-maker-v2', 'apps_script');
const jp = path.join(root, 'assets', 'lesson-aliases.json');
// The alias code is in Phase2_Keys.gs, or in Code.gs once Phase2_Keys.gs was merged in and deleted.
const gp = fs.existsSync(path.join(gsDir, 'Phase2_Keys.gs')) ? path.join(gsDir, 'Phase2_Keys.gs') : path.join(gsDir, 'Code.gs');
t('assets/lesson-aliases.json exists', fs.existsSync(jp));
t('the file holding the alias map exists (' + path.basename(gp) + ')', fs.existsSync(gp));
if (fs.existsSync(jp) && fs.existsSync(gp)) {
  let json = {}, err = ''; try { json = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch (e) { err = e.message; }
  t('the JSON parses', !err, err);
  const raw = json.aliases || json;   // either {aliases:{old:new}} or {old:new}
  const map = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));   // ignore "_comment"
  const ctx = vm.createContext({}); let gerr = '';
  try { vm.runInContext(fs.readFileSync(gp, 'utf8'), ctx); } catch (e) { gerr = e.message; }
  t(path.basename(gp) + ' loads alone', !gerr, gerr);
  const gsMap = ctx.P2_LESSON_ALIASES || {};
  t('P2_LESSON_ALIASES is defined', !!ctx.P2_LESSON_ALIASES);
  t('the JSON and the .gs map are identical (R-001b)', JSON.stringify(Object.entries(map).sort()) === JSON.stringify(Object.entries(gsMap).sort()));
  for (const [o, n] of Object.entries(MUST)) {
    t('JSON maps ' + o.split('/').pop() + (o.includes('/') ? ' (full path)' : ' (bare slug)'), map[o] === n, String(map[o]));
    if (typeof ctx.p2k_canon === 'function') t('p2k_canon resolves ' + o.split('/').pop() + (o.includes('/') ? ' (full path)' : ' (bare)'), ctx.p2k_canon(o) === n, String(ctx.p2k_canon(o)));
  }
  t('p2k_canon is exported', typeof ctx.p2k_canon === 'function' && typeof ctx.p2k_aliases === 'function' && typeof ctx.p2k_same === 'function');
  if (typeof ctx.p2k_canon === 'function') {
    const k = G2 + 'chapter-1-lesson-4-ethical-issues-with-ai';
    t('p2k_canon leaves a current key untouched and is idempotent', ctx.p2k_canon(k) === k && ctx.p2k_canon(ctx.p2k_canon(Object.keys(MUST)[1])) === MUST[Object.keys(MUST)[1]]);
    t('p2k_canon leaves unknown strings untouched', ctx.p2k_canon('english/x/y') === 'english/x/y');
    t('no alias points at another alias (no chains)', Object.values(map).every(v => !(v in map)));
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
