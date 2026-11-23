#!/usr/bin/env node
'use strict';
// Teacher publishing check (refactor Phase 2.5, step E). Refuses a teacher's pull request unless it is something the
// owner would push himself. Runs in CI from the BASE branch (pull_request_target): it only READS the pull request's
// files with git; nothing from the pull request is ever executed.
//
//   node scripts/check_teacher_pr.js --base <sha> --head <sha> --branch teacher/<handle>/<topic> --author <github login>
//   node scripts/check_teacher_pr.js --self-test       (the rules on built-in examples; also run by the test suite)
//
// Config: .github/teachers.json (read from the base branch, so a teacher cannot change his own rules):
//   { "teachers": { "<handle>": { "name": "...", "github": "<login>", "subjects": ["science"], "auto_merge": false } } }
//
// The rules (docs/handoff/teacher-publishing.md explains them to the owner):
//   1. The branch is teacher/<handle>/..., <handle> is in teachers.json, and the pull request is opened by that
//      teacher's GitHub account.
//   2. Every changed file is inside one of his subjects' folders (<subject>/<grade>/...), never the subject's own front
//      page (<subject>/index.html). Two shared files the Quiz Maker's SEO step rewrites are allowed only when every
//      change in them is about his subjects: sitemap.xml and assets/lesson-titles.json. Nothing else: no assets/,
//      dashboard/, backend, tools/, scripts/, tests/, docs/, .github/ or root files.
//   3. Only lesson file types: .html .css .json .png .jpg .jpeg .webp .gif .pdf. No links (symlinks), no submodules.
//   4. Lesson HTML may load only the shared engines (/assets/<engine>.js), may hold JSON data blocks, and may contain
//      only inline scripts the owner's own pages already use (the Quiz Maker templates and the lessons already on the
//      base branch). No event-handler attributes (one known theme fallback aside), no javascript: links, no
//      <object>/<embed>/<base>/<meta refresh>, frames only from the video hosts; inline SVG icons without the parts that
//      can run or load content (foreignObject, animate/set, external <use>).
//   5. CSS without script tricks (javascript:, expression(), behavior:, @import). JSON must parse.
//   6. Size: 2 MB per file (8 MB for a PDF), 20 MB for the whole pull request.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED_EXT = ['.html', '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf'];
const TEXT_EXT = ['.html', '.css', '.json'];
const MAX_FILE = 2 * 1024 * 1024, MAX_PDF = 8 * 1024 * 1024, MAX_TOTAL = 20 * 1024 * 1024;
const SHARED_SEO_FILES = ['sitemap.xml', 'assets/lesson-titles.json'];
const FRAME_HOSTS = [/^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//, /^https:\/\/player\.vimeo\.com\/video\//, /^https:\/\/drive\.google\.com\/file\/d\/[^/]+\/preview/];
const KNOWN_HANDLER = /^onerror="window\.__themeJsFailed = true"$/;

const norm = s => String(s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- inline scripts the owner already uses
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ attrs: m[1], body: m[2] });
  return out;
}
function knownInlineScripts(readBase) {
  const known = new Set();
  readBase.htmlFiles().forEach(f => inlineScripts(readBase.read(f)).forEach(s => {
    if (!/\bsrc\s*=/.test(s.attrs) && !/type\s*=\s*["']?application\/(ld\+)?json/i.test(s.attrs) && s.body.trim()) known.add(norm(s.body));
  }));
  return known;
}
function sharedEngines(readBase) {
  return new Set(readBase.assetScripts());
}

// ---------------------------------------------------------------- one HTML file
function checkHtml(file, html, known, engines) {
  const errs = [];
  inlineScripts(html).forEach(s => {
    const src = (s.attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (src !== undefined) {
      const m = /^\/assets\/([a-z0-9-]+\.js)(\?v=\d+)?$/.exec(src);
      if (!m || !engines.has(m[1])) errs.push(`${file}: loads a script that is not a shared engine: ${src}`);
      if (s.body.trim()) errs.push(`${file}: a script tag with src also holds code`);
      return;
    }
    if (/type\s*=\s*["']?application\/(ld\+)?json/i.test(s.attrs)) {
      try { JSON.parse(s.body.replace(/^\s*<!--|-->\s*$/g, '')); } catch (e) { errs.push(`${file}: a JSON data block does not parse`); }
      return;
    }
    if (/type\s*=/i.test(s.attrs) && !/type\s*=\s*["']?(text\/javascript|module)["']?/i.test(s.attrs)) { errs.push(`${file}: unknown script type`); return; }
    if (!known.has(norm(s.body))) errs.push(`${file}: an inline script that the owner's pages do not use: ${norm(s.body).slice(0, 80)}`);
  });
  const tags = html.match(/<[a-zA-Z][^>]*>/g) || [];
  tags.forEach(tag => {
    (tag.match(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi) || []).forEach(h => {
      if (!KNOWN_HANDLER.test(h.trim())) errs.push(`${file}: event-handler attribute ${h.trim().slice(0, 60)}`);
    });
    if (/\b(href|src|action|formaction|data|xlink:href)\s*=\s*["']?\s*(javascript|vbscript|data:text\/html)/i.test(tag)) errs.push(`${file}: a javascript: or data: link`);
    const name = (tag.match(/^<([a-zA-Z0-9-]+)/) || [])[1].toLowerCase();
    if (['object', 'embed', 'applet', 'base', 'frame', 'frameset'].includes(name)) errs.push(`${file}: <${name}> is not allowed`);
    if (name === 'meta' && /http-equiv\s*=\s*["']?refresh/i.test(tag)) errs.push(`${file}: <meta http-equiv="refresh"> is not allowed`);
    if (name === 'iframe') {
      const src = (tag.match(/\ssrc\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
      if (!FRAME_HOSTS.some(r => r.test(src))) errs.push(`${file}: a frame from a host that is not a video host: ${src.slice(0, 80)}`);
    }
    // Inline SVG icons are fine (the owner's pages use them); the parts of SVG that can run or pull in content are not.
    if (['foreignobject', 'animate', 'set', 'animatemotion', 'animatetransform', 'handler', 'listener'].includes(name)) errs.push(`${file}: <${name}> is not allowed`);
    if (name === 'use' && /hrefs*=s*["']?s*(?!#)[^s>]/i.test(tag)) errs.push(`${file}: <use> may only point inside the page (#id)`);
  });
  return errs;
}

function checkCss(file, css) {
  return /javascript:|expression\s*\(|behavior\s*:|-moz-binding|@import/i.test(css) ? [`${file}: CSS with script tricks or @import`] : [];
}

// ---------------------------------------------------------------- the two shared SEO files
function sitemapUrls(xml) {
  const out = new Map();
  (String(xml || '').match(/<url>[\s\S]*?<\/url>/g) || []).forEach(u => {
    const loc = (u.match(/<loc>([^<]*)<\/loc>/) || [])[1];
    if (loc) out.set(loc, norm(u));
  });
  return out;
}
function inSubjects(urlOrPath, subjects) {
  const p = String(urlOrPath).replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '');
  return subjects.some(s => p.startsWith(s + '/') && p !== s + '/' && p !== s + '/index.html');
}
function checkSitemap(before, after, subjects) {
  const a = sitemapUrls(before), b = sitemapUrls(after), errs = [];
  new Set([...a.keys(), ...b.keys()]).forEach(loc => {
    if (a.get(loc) !== b.get(loc) && !inSubjects(loc, subjects)) errs.push(`sitemap.xml: changes an entry outside your subjects: ${loc}`);
  });
  const strip = x => String(x || '').replace(/<url>[\s\S]*?<\/url>/g, '').replace(/\s+/g, '');
  if (strip(before) !== strip(after)) errs.push('sitemap.xml: changes outside the <url> entries');
  return errs;
}
function checkLessonTitles(before, after, subjects) {
  let a, b;
  try { a = before ? JSON.parse(before) : {}; b = JSON.parse(after); } catch (e) { return ['assets/lesson-titles.json: does not parse']; }
  const flat = o => {
    if (Array.isArray(o)) return new Map(o.map((x, i) => [String((x && (x.path || x.lesson || x.url)) || i), JSON.stringify(x)]));
    return new Map(Object.keys(o || {}).map(k => [k, JSON.stringify(o[k])]));
  };
  const fa = flat(a), fb = flat(b), errs = [];
  new Set([...fa.keys(), ...fb.keys()]).forEach(k => {
    if (fa.get(k) !== fb.get(k) && !inSubjects(k, subjects)) errs.push(`assets/lesson-titles.json: changes an entry outside your subjects: ${k}`);
  });
  return errs;
}

// ---------------------------------------------------------------- the whole pull request (pure: easy to test)
// change = { teachers, branch, author, files: [{ path, status: A|M|D|R, oldPath, mode, size, content, baseContent }],
//            known: Set of inline script bodies, engines: Set of engine file names }
function checkChange(change) {
  const errs = [];
  const m = /^teacher\/([a-z0-9][a-z0-9-]*)\/[A-Za-z0-9._\/-]+$/.exec(String(change.branch || ''));
  if (!m) return { ok: false, teacher: null, errors: [`branch "${change.branch}" is not teacher/<your-name>/<topic>`] };
  const handle = m[1], t = (change.teachers || {})[handle];
  if (!t) return { ok: false, teacher: handle, errors: [`"${handle}" is not in .github/teachers.json`] };
  if (!t.github) errs.push(`teachers.json has no GitHub account for "${handle}" yet (the owner adds it)`);
  else if (String(change.author || '').toLowerCase() !== String(t.github).toLowerCase()) errs.push(`this pull request was opened by "${change.author}", not by ${handle}'s account`);
  const subjects = (t.subjects || []).map(s => String(s).toLowerCase()).filter(s => /^[a-z]+$/.test(s));
  if (!subjects.length) errs.push(`teachers.json gives "${handle}" no subjects`);
  const files = change.files || [];
  if (!files.length) errs.push('the pull request changes no files');
  let total = 0;
  files.forEach(f => {
    const paths = [f.path].concat(f.oldPath && f.oldPath !== f.path ? [f.oldPath] : []);
    if (f.mode === '120000') errs.push(`${f.path}: links (symlinks) are not allowed`);
    if (f.mode === '160000') errs.push(`${f.path}: submodules are not allowed`);
    const shared = SHARED_SEO_FILES.includes(f.path) && paths.length === 1;
    if (!shared) paths.forEach(p => { if (!inSubjects(p, subjects)) errs.push(`${p}: outside your subject folders (${subjects.map(s => s + '/').join(', ')})`); });
    if (f.status === 'D') return;
    const ext = path.extname(f.path).toLowerCase();
    if (!shared && !ALLOWED_EXT.includes(ext)) errs.push(`${f.path}: file type ${ext || '(none)'} is not a lesson file`);
    const size = f.size || 0;
    total += size;
    if (size > (ext === '.pdf' ? MAX_PDF : MAX_FILE)) errs.push(`${f.path}: ${(size / 1048576).toFixed(1)} MB is too big`);
    if (f.path === 'sitemap.xml') { errs.push(...checkSitemap(f.baseContent, f.content, subjects)); return; }
    if (f.path === 'assets/lesson-titles.json') { errs.push(...checkLessonTitles(f.baseContent, f.content, subjects)); return; }
    if (ext === '.html') errs.push(...checkHtml(f.path, String(f.content || ''), change.known || new Set(), change.engines || new Set()));
    if (ext === '.css') errs.push(...checkCss(f.path, String(f.content || '')));
    if (ext === '.json') { try { JSON.parse(String(f.content || '')); } catch (e) { errs.push(`${f.path}: does not parse as JSON`); } }
  });
  if (total > MAX_TOTAL) errs.push(`the pull request adds ${(total / 1048576).toFixed(1)} MB (limit ${MAX_TOTAL / 1048576} MB)`);
  return { ok: errs.length === 0, teacher: handle, autoMerge: !!t.auto_merge, errors: [...new Set(errs)] };
}

// ---------------------------------------------------------------- git (CLI only)
function git(args, opts) { return execFileSync('git', args, Object.assign({ cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }, opts || {})); }
function gitText(args) { return git(args).toString('utf8'); }
function fromGit(base, head) {
  const mb = gitText(['merge-base', base, head]).trim();
  const raw = gitText(['diff', '--raw', '-z', '-M', '--no-abbrev', mb, head]).split('\0');
  const files = [];
  for (let i = 0; i < raw.length - 1;) {
    const meta = raw[i++]; if (!meta) continue;
    const [, newMode] = meta.slice(1).split(' '), status = meta.trim().split(/\s+/).pop()[0];
    let oldPath = null, p = raw[i++];
    if (status === 'R' || status === 'C') { oldPath = p; p = raw[i++]; }
    const f = { path: p, oldPath, status, mode: newMode };
    if (status !== 'D') {
      f.size = parseInt(gitText(['cat-file', '-s', `${head}:${p}`]).trim(), 10);
      if (TEXT_EXT.includes(path.extname(p).toLowerCase()) || SHARED_SEO_FILES.includes(p)) f.content = gitText(['show', `${head}:${p}`]);
      if (SHARED_SEO_FILES.includes(p)) { try { f.baseContent = gitText(['show', `${mb}:${p}`]); } catch (e) { f.baseContent = ''; } }
    }
    files.push(f);
  }
  return files;
}
function baseReader(base) {
  const all = gitText(['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean);
  return {
    htmlFiles: () => all.filter(f => /\.html$/.test(f) && (/^tools\/quiz-maker-v2\/templates\//.test(f) || /^(programming|english|math|science)\//.test(f))),
    read: f => gitText(['show', `${base}:${f}`]),
    assetScripts: () => all.filter(f => /^assets\/[a-z0-9-]+\.js$/.test(f)).map(f => f.slice('assets/'.length)),
  };
}

// ---------------------------------------------------------------- self-test (also run by tests/test_p25_publish.js)
function selfTest() {
  const teachers = { mona: { name: 'Ms Mona', github: 'mona-gh', subjects: ['science'], auto_merge: false } };
  const known = new Set([norm("QuizEngine.mount('#quiz-root', '#quiz-data');")]);
  const engines = new Set(['quiz.js', 'auth.js', 'video.js']);
  const page = body => `<!doctype html><html><head><script src="/assets/auth.js"></script></head><body>${body}<script src="/assets/quiz.js"></script><script>QuizEngine.mount('#quiz-root', '#quiz-data');</script></body></html>`;
  const base = { teachers, branch: 'teacher/mona/matter', author: 'mona-gh', known, engines };
  const L = 'science/secondary/grade-1-secondary/chapter-1-lesson-1/';
  const ok = files => checkChange(Object.assign({}, base, { files }));
  const f = (p, content, extra) => Object.assign({ path: p, status: 'A', mode: '100644', size: Buffer.byteLength(content || ''), content }, extra || {});
  const cases = [
    ['a clean lesson passes', ok([f(L + 'quiz.html', page('<p>hi</p>')), f(L + 'base.css', 'body{color:red}'), f(L + 'attachments.json', '[]')]).ok, true],
    ['wrong branch name', checkChange(Object.assign({}, base, { branch: 'main', files: [f(L + 'a.css', 'a{}')] })).ok, false],
    ['unknown teacher', checkChange(Object.assign({}, base, { branch: 'teacher/zed/x', files: [f(L + 'a.css', 'a{}')] })).ok, false],
    ['someone else opened it', checkChange(Object.assign({}, base, { author: 'other', files: [f(L + 'a.css', 'a{}')] })).ok, false],
    ['another subject', ok([f('math/x/lesson/quiz.html', page(''))]).ok, false],
    ['the subject front page', ok([f('science/index.html', page(''))]).ok, false],
    ['assets/', ok([f('assets/quiz.js', 'x')]).ok, false],
    ['dashboard/', ok([f('dashboard/x.html', page(''))]).ok, false],
    ['backend', ok([f('tools/quiz-maker-v2/apps_script/Code.gs', 'x')]).ok, false],
    ['workflow', ok([f('.github/workflows/x.yml', 'x')]).ok, false],
    ['rename out of his folder', ok([f('dashboard/x.html', page(''), { status: 'R', oldPath: L + 'x.html' })]).ok, false],
    ['not a lesson file type', ok([f(L + 'run.js', 'alert(1)')]).ok, false],
    ['svg file', ok([f(L + 'pic.svg', '<svg onload=alert(1)>')]).ok, false],
    ['inline svg icon passes', ok([f(L + 'quiz.html', page('<svg viewBox="0 0 24 24"><path d="M0 0h24"/></svg>'))]).ok, true],
    ['svg with a handler', ok([f(L + 'quiz.html', page('<svg><circle onload="alert(1)"/></svg>'))]).ok, false],
    ['svg foreignObject', ok([f(L + 'quiz.html', page('<svg><foreignObject><p>x</p></foreignObject></svg>'))]).ok, false],
    ['svg animate', ok([f(L + 'quiz.html', page('<svg><a><animate attributeName="href" values="x"/></a></svg>'))]).ok, false],
    ['svg external use', ok([f(L + 'quiz.html', page('<svg><use href="https://evil.example/x.svg#a"/></svg>'))]).ok, false],
    ['symlink', ok([f(L + 'quiz.html', '../../../assets', { mode: '120000' })]).ok, false],
    ['new inline script', ok([f(L + 'quiz.html', page('<script>fetch("x")</script>'))]).ok, false],
    ['foreign script src', ok([f(L + 'quiz.html', page('<script src="https://evil.example/x.js"></script>'))]).ok, false],
    ['relative script src', ok([f(L + 'quiz.html', page('<script src="./x.js"></script>'))]).ok, false],
    ['event handler', ok([f(L + 'quiz.html', page('<img src="a.png" onerror="alert(1)">'))]).ok, false],
    ['javascript: link', ok([f(L + 'quiz.html', page('<a href="javascript:alert(1)">x</a>'))]).ok, false],
    ['object tag', ok([f(L + 'quiz.html', page('<object data="x"></object>'))]).ok, false],
    ['frame from another host', ok([f(L + 'quiz.html', page('<iframe src="https://evil.example/"></iframe>'))]).ok, false],
    ['youtube frame passes', ok([f(L + 'quiz.html', page('<iframe src="https://www.youtube.com/embed/abc"></iframe>'))]).ok, true],
    ['JSON data block passes', ok([f(L + 'quiz.html', page('<script type="application/json" id="quiz-data">{"q":1}</script>'))]).ok, true],
    ['the known theme fallback handler passes', ok([f(L + 'quiz.html', page('<script src="/assets/video.js?v=3" onerror="window.__themeJsFailed = true"></script>'))]).ok, true],
    ['CSS @import', ok([f(L + 'base.css', '@import url(https://evil.example/x.css);')]).ok, false],
    ['bad JSON', ok([f(L + 'attachments.json', '{')]).ok, false],
    ['too big', ok([f(L + 'pic.png', '', { size: 3 * 1048576 })]).ok, false],
    ['big PDF within its limit', ok([f(L + 'notes.pdf', '', { size: 5 * 1048576 })]).ok, true],
    ['sitemap: only his URLs', ok([f('sitemap.xml', '<urlset><url><loc>https://x/science/secondary/grade-1-secondary/a/</loc></url><url><loc>https://x/math/</loc></url></urlset>', { status: 'M', baseContent: '<urlset><url><loc>https://x/math/</loc></url></urlset>' })]).ok, true],
    ['sitemap: touching math', ok([f('sitemap.xml', '<urlset></urlset>', { status: 'M', baseContent: '<urlset><url><loc>https://x/math/</loc></url></urlset>' })]).ok, false],
    ['lesson titles: only his', ok([f('assets/lesson-titles.json', '{"science/secondary/grade-1-secondary/a":"A","math/b":"B"}', { status: 'M', baseContent: '{"math/b":"B"}' })]).ok, true],
    ['lesson titles: renaming math', ok([f('assets/lesson-titles.json', '{"math/b":"X"}', { status: 'M', baseContent: '{"math/b":"B"}' })]).ok, false],
    ['deleting his lesson passes', ok([{ path: L + 'quiz.html', status: 'D', mode: '000000' }]).ok, true],
    ['deleting a math lesson', ok([{ path: 'math/x/quiz.html', status: 'D', mode: '000000' }]).ok, false],
    ['auto_merge is reported from the config', checkChange(Object.assign({}, base, { teachers: { mona: Object.assign({}, teachers.mona, { auto_merge: true }) }, files: [f(L + 'a.css', 'a{}')] })).autoMerge, true],
  ];
  let fails = 0;
  cases.forEach(([name, got, want]) => { const pass = got === want; if (!pass) fails++; console.log((pass ? 'PASS ' : 'FAIL ') + 'rule: ' + name + (pass ? '' : `  (got ${got}, want ${want})`)); });
  return fails;
}

function main(argv) {
  if (argv.includes('--self-test')) process.exit(selfTest() ? 1 : 0);
  const arg = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : ''; };
  const base = arg('base'), head = arg('head');
  if (!base || !head) { console.error('usage: check_teacher_pr.js --base <sha> --head <sha> --branch <ref> --author <login>'); process.exit(2); }
  const cfgText = gitText(['show', `${base}:.github/teachers.json`]);
  const teachers = JSON.parse(cfgText).teachers || {};
  const rb = baseReader(base);
  const res = checkChange({ teachers, branch: arg('branch'), author: arg('author'), files: fromGit(base, head), known: knownInlineScripts(rb), engines: sharedEngines(rb) });
  if (res.ok) console.log(`OK: everything in this pull request is a lesson file in ${res.teacher}'s subjects.`);
  else { console.log(`REFUSED (${res.errors.length}):`); res.errors.forEach(e => console.log('  - ' + e)); }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${res.ok}\nauto_merge=${!!res.autoMerge}\nteacher=${res.teacher || ''}\n`);
  process.exit(res.ok ? 0 : 1);
}

module.exports = { checkChange, checkHtml, checkSitemap, checkLessonTitles, inSubjects, selfTest };
if (require.main === module) main(process.argv.slice(2));
