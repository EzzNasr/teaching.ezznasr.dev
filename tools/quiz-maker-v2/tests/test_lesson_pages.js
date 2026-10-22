// R-001 / R-002 (static half). Usage: node tests/test_lesson_pages.js [site root]
// Every lesson folder (a folder with index.html next to quiz.html and/or assignment.html):
//   R-001  canonical, og:url and JSON-LD "url" for the page itself equal the page's own URL;
//          data-lesson and the quiz data "lesson" equal the folder name;
//   R-002  every root-relative href/src in the page points at a file or folder that exists
//          (a folder needs an index.html), so no quiz/homework link is a 404.
// Written by Session 5. Prints one PASS/FAIL line per check, exits 1 on any FAIL.
const fs = require('fs'), path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const SITE = 'https://teaching.ezznasr.dev';
let pass = 0, fail = 0;
const ONLY = process.argv[3] || '';
const t = (n, c, x) => { const id = (/^(R-\d+)/.exec(n) || [])[1]; if (ONLY && id && id !== ONLY) return; (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || /^(\.|_|node_modules$|tools$|Docs$)/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    yield p; yield* walk(p);
  }
}
const lessonDirs = [];
for (const sub of ['programming', 'english', 'math'])
  if (fs.existsSync(path.join(root, sub))) for (const d of walk(path.join(root, sub)))
    if (fs.existsSync(path.join(d, 'index.html')) && (fs.existsSync(path.join(d, 'quiz.html')) || fs.existsSync(path.join(d, 'assignment.html')))) lessonDirs.push(d);

const exists = rel => {   // rel: root-relative path without query/hash
  const p = path.join(root, decodeURIComponent(rel));
  if (!fs.existsSync(p)) return false;
  return fs.statSync(p).isDirectory() ? fs.existsSync(path.join(p, 'index.html')) : true;
};
const bad = [];
for (const dir of lessonDirs) {
  const key = path.relative(root, dir).split(path.sep).join('/'), slug = path.basename(dir);
  for (const file of ['index.html', 'quiz.html', 'assignment.html']) {
    const fp = path.join(dir, file); if (!fs.existsSync(fp)) continue;
    const html = fs.readFileSync(fp, 'utf8'), id = key + '/' + file, own = SITE + '/' + key + '/' + (file === 'index.html' ? '' : file);
    const problems = [];
    const canon = /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/.exec(html) || /<link[^>]*href="([^"]*)"[^>]*rel="canonical"/.exec(html);
    if (canon && canon[1] !== own) problems.push('canonical ' + canon[1]);
    const og = /<meta[^>]*property="og:url"[^>]*content="([^"]*)"/.exec(html);
    if (og && og[1] !== own) problems.push('og:url ' + og[1]);
    for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g))
      for (const u of m[1].matchAll(/"url"\s*:\s*"(https:\/\/teaching\.ezznasr\.dev\/[^"]*)"/g))
        if (/\/(programming|english|math)\//.test(u[1]) && u[1] !== own) problems.push('JSON-LD url ' + u[1]);
    for (const m of html.matchAll(/data-lesson="([^"]*)"/g)) if (m[1] !== slug) problems.push('data-lesson ' + m[1]);
    for (const m of html.matchAll(/"lesson"\s*:\s*"([^"]*)"/g)) if (m[1] !== slug) problems.push('"lesson" ' + m[1]);
    t('R-001 ' + id + ': own-name references', !problems.length, problems.join('; '));
    const dead = [];
    for (const m of html.matchAll(/\b(?:href|src)="(\/[^"#?]*)/g)) if (m[1] !== '/' && !exists(m[1].replace(/^\//, ''))) dead.push(m[1]);
    t('R-002 ' + id + ': internal links resolve', !dead.length, [...new Set(dead)].join(', '));
  }
}
t('found lesson folders to check', lessonDirs.length > 0, 'none found under ' + root);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
