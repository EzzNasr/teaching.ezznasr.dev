#!/usr/bin/env node
'use strict';
// Teacher publishing check (refactor Phase 2.5, steps E and G). Refuses a teacher's pull request unless it only adds
// or changes FILES on lessons the owner already made. Runs in CI from the BASE branch (pull_request_target): it only
// READS the pull request's files with git; nothing from the pull request is ever executed.
//
//   node scripts/check_teacher_pr.js --base <sha> --head <sha> --branch teacher/<handle>/<topic> --author <github login>
//   node scripts/check_teacher_pr.js --self-test       (the rules on built-in examples; also run by the test suite)
//
// Config: .github/teachers.json (read from the base branch, so a teacher cannot change his own rules):
//   { "teachers": { "<handle>": { "name": "...", "github": "<login>", "subjects": ["science"], "auto_merge": false } } }
//
// The rules (docs/handoff/teacher-publishing.md explains them to the owner). The owner makes every lesson (its folder,
// name, pages and place on the grade page); the teacher fills it with videos (straight to the backend with his token,
// never through a pull request) and files (this check):
//   1. The branch is teacher/<handle>/..., <handle> is in teachers.json, and the pull request is opened by that
//      teacher's GitHub account.
//   2. Every changed file sits directly inside a lesson folder that already exists on the base branch (a folder with a
//      quiz.html) in one of his subjects. So no new lessons, no deleted or renamed lessons, no grade pages, no
//      sitemap.xml / assets/lesson-titles.json, nothing outside his subjects.
//   3. In that folder only the file list and its files: attachments.json (changed or added, never deleted) and
//      attachment files (.pdf .png .jpg .jpeg .webp .gif). Never the lesson pages (index.html, quiz.html,
//      assignment.html), stylesheets or any other file. No links (symlinks), no submodules.
//   4. attachments.json must be the Quiz Maker's own shape: a list of {title, drive_file_id, type}, with an optional
//      section (lesson | quiz | assignment: the page that shows the file).
//   5. Size: 2 MB per file (8 MB for a PDF), 20 MB for the whole pull request.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILE_LIST = 'attachments.json';
const ATTACH_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
const LESSON_PAGES = ['index.html', 'quiz.html', 'assignment.html'];
const MAX_FILE = 2 * 1024 * 1024, MAX_PDF = 8 * 1024 * 1024, MAX_TOTAL = 20 * 1024 * 1024;

const dirOf = p => { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };
const baseOf = p => String(p).slice(String(p).lastIndexOf('/') + 1);
const subjectOf = p => String(p).split('/')[0];

// The lesson folders on the base branch: every folder (inside a subject) that holds a quiz.html. -> Set of 'a/b/c/'.
function lessonFolders(paths) {
  const out = new Set();
  paths.forEach(p => { if (baseOf(p) === 'quiz.html' && p.split('/').length >= 3) out.add(dirOf(p)); });
  return out;
}

// attachments.json: exactly what the Quiz Maker's Attachment section writes.
function checkFileList(file, text) {
  let v;
  try { v = JSON.parse(String(text || '')); } catch (e) { return [`${file}: does not parse as JSON`]; }
  if (!Array.isArray(v)) return [`${file}: must be a list of files`];
  const errs = [];
  v.forEach((it, i) => {
    const ok = it && typeof it === 'object' && !Array.isArray(it) &&
      Object.keys(it).every(k => ['title', 'drive_file_id', 'type', 'section'].includes(k)) &&
      (it.section === undefined || ['lesson', 'quiz', 'assignment'].includes(it.section)) &&
      typeof it.title === 'string' && it.title.length <= 200 &&
      typeof it.drive_file_id === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(it.drive_file_id) &&
      (it.type === undefined || (typeof it.type === 'string' && /^[a-z0-9]{0,10}$/i.test(it.type)));
    if (!ok) errs.push(`${file}: entry ${i + 1} is not {title, drive_file_id, type} as the Quiz Maker writes it`);
  });
  return errs;
}

// Why one path is not allowed (or null when it is). lessons = Set of lesson folders on the base branch.
function pathProblem(p, subjects, lessons) {
  const sub = subjectOf(p), dir = dirOf(p), name = baseOf(p);
  if (!subjects.includes(sub) || !dir) return `${p}: outside your subject folders (${subjects.map(s => s + '/').join(', ')})`;
  if (!lessons.has(dir)) {
    if ([...lessons].some(l => l.startsWith(dir))) return `${p}: grade and subject pages are made by the owner (lesson names and lists are fixed)`;
    return `${p}: not inside an existing lesson; new lessons are added by the owner`;
  }
  if (LESSON_PAGES.includes(name)) return `${p}: lesson pages are made by the owner (names are fixed); add videos with the Quiz Maker and files to attachments.json`;
  if (name !== FILE_LIST && !ATTACH_EXT.includes(path.extname(name).toLowerCase())) return `${p}: only attachments.json and attachment files (${ATTACH_EXT.join(' ')}) may change in a lesson`;
  return null;
}

// ---------------------------------------------------------------- the whole pull request (pure: easy to test)
// change = { teachers, branch, author, lessons: Set of lesson folders on the base branch,
//            files: [{ path, status: A|M|D|R|C, oldPath, mode, size, content }] }
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
  const lessons = change.lessons || new Set();
  const files = change.files || [];
  if (!files.length) errs.push('the pull request changes no files');
  let total = 0;
  files.forEach(f => {
    const paths = [f.path].concat(f.oldPath && f.oldPath !== f.path ? [f.oldPath] : []);
    if (f.mode === '120000') errs.push(`${f.path}: links (symlinks) are not allowed`);
    if (f.mode === '160000') errs.push(`${f.path}: submodules are not allowed`);
    paths.forEach(p => { const why = pathProblem(p, subjects, lessons); if (why) errs.push(why); });
    if (baseOf(f.path) === FILE_LIST && f.status === 'D') errs.push(`${f.path}: the lesson's file list cannot be deleted (empty it instead: [])`);
    if (f.oldPath && f.oldPath !== f.path && baseOf(f.oldPath) === FILE_LIST && f.status === 'R') errs.push(`${f.oldPath}: the lesson's file list cannot be renamed`);
    if (f.status === 'D') return;
    const ext = path.extname(f.path).toLowerCase();
    const size = f.size || 0;
    total += size;
    if (size > (ext === '.pdf' ? MAX_PDF : MAX_FILE)) errs.push(`${f.path}: ${(size / 1048576).toFixed(1)} MB is too big`);
    if (baseOf(f.path) === FILE_LIST) errs.push(...checkFileList(f.path, f.content));
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
      if (baseOf(p) === FILE_LIST) f.content = gitText(['show', `${head}:${p}`]);
    }
    files.push(f);
  }
  return files;
}
function baseLessons(base) {
  return lessonFolders(gitText(['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean));
}

// ---------------------------------------------------------------- self-test (also run by tests/test_p25_publish.js)
function selfTest() {
  const teachers = { mona: { name: 'Ms Mona', github: 'mona-gh', subjects: ['science'], auto_merge: false } };
  const G = 'science/secondary/grade-1-secondary/';
  const L = G + 'chapter-1-lesson-1/';
  const lessons = lessonFolders([G + 'index.html', L + 'index.html', L + 'quiz.html', L + 'attachments.json',
    G + 'chapter-1-lesson-2/quiz.html', 'math/algebra/chapter-1-lesson-1/quiz.html']);
  const base = { teachers, branch: 'teacher/mona/files', author: 'mona-gh', lessons };
  const ok = files => checkChange(Object.assign({}, base, { files }));
  const f = (p, content, extra) => Object.assign({ path: p, status: 'M', mode: '100644', size: Buffer.byteLength(content || ''), content }, extra || {});
  const list = JSON.stringify([{ title: 'Worksheet', drive_file_id: '1zaxQFvbs2wp7Xq9NPWUYDQVca66W8tQh', type: 'pdf' }]);
  const cases = [
    ['adding a file to an existing lesson passes', ok([f(L + 'attachments.json', list)]).ok, true],
    ['emptying the file list passes', ok([f(L + 'attachments.json', '[]')]).ok, true],
    ['an attachment file in an existing lesson passes', ok([f(L + 'worksheet.pdf', '', { status: 'A', size: 5 * 1048576 })]).ok, true],
    ['removing an attachment file passes', ok([{ path: L + 'old.png', status: 'D', mode: '000000' }]).ok, true],
    ['wrong branch name', checkChange(Object.assign({}, base, { branch: 'main', files: [f(L + 'attachments.json', '[]')] })).ok, false],
    ['unknown teacher', checkChange(Object.assign({}, base, { branch: 'teacher/zed/x', files: [f(L + 'attachments.json', '[]')] })).ok, false],
    ['someone else opened it', checkChange(Object.assign({}, base, { author: 'other', files: [f(L + 'attachments.json', '[]')] })).ok, false],
    ['renaming a lesson (lesson page)', ok([f(L + 'index.html', '<h1>New name</h1>')]).ok, false],
    ['editing the quiz page', ok([f(L + 'quiz.html', '<html></html>')]).ok, false],
    ['editing the assignment page', ok([f(L + 'assignment.html', '<html></html>')]).ok, false],
    ['a new lesson folder', ok([f(G + 'chapter-9-lesson-1/attachments.json', '[]', { status: 'A' })]).ok, false],
    ['a new lesson page', ok([f(G + 'my-lesson/index.html', '<html></html>', { status: 'A' })]).ok, false],
    ['deleting a lesson', ok([{ path: L + 'quiz.html', status: 'D', mode: '000000' }, { path: L + 'index.html', status: 'D', mode: '000000' }]).ok, false],
    ['moving a lesson folder', ok([f(G + 'renamed/quiz.html', 'x', { status: 'R', oldPath: L + 'quiz.html' })]).ok, false],
    ['the grade page', ok([f(G + 'index.html', '<html></html>')]).ok, false],
    ['the subject front page', ok([f('science/index.html', '<html></html>')]).ok, false],
    ['sitemap.xml', ok([f('sitemap.xml', '<urlset></urlset>')]).ok, false],
    ['lesson titles', ok([f('assets/lesson-titles.json', '{}')]).ok, false],
    ['another subject', ok([f('math/algebra/chapter-1-lesson-1/attachments.json', '[]')]).ok, false],
    ['assets/', ok([f('assets/quiz.js', 'x')]).ok, false],
    ['workflow', ok([f('.github/workflows/x.yml', 'x')]).ok, false],
    ['a stylesheet in a lesson', ok([f(L + 'base.css', 'body{}')]).ok, false],
    ['a script in a lesson', ok([f(L + 'run.js', 'alert(1)', { status: 'A' })]).ok, false],
    ['an svg in a lesson', ok([f(L + 'pic.svg', '<svg onload=alert(1)>', { status: 'A' })]).ok, false],
    ['a file in a lesson subfolder', ok([f(L + 'sub/x.pdf', '', { status: 'A' })]).ok, false],
    ['deleting the file list', ok([{ path: L + 'attachments.json', status: 'D', mode: '000000' }]).ok, false],
    ['symlink', ok([f(L + 'x.png', '../../../assets', { status: 'A', mode: '120000' })]).ok, false],
    ['bad JSON in the file list', ok([f(L + 'attachments.json', '{')]).ok, false],
    ['the file list is not a list', ok([f(L + 'attachments.json', '{"title":"x"}')]).ok, false],
    ['a file for the quiz page passes', ok([f(L + 'attachments.json', JSON.stringify([{ title: 'x', drive_file_id: '1zaxQFvbs2wp7Xq9NPW', type: 'pdf', section: 'quiz' }]))]).ok, true],
    ['an unknown section', ok([f(L + 'attachments.json', JSON.stringify([{ title: 'x', drive_file_id: '1zaxQFvbs2wp7Xq9NPW', type: 'pdf', section: 'home' }]))]).ok, false],
    ['an extra field in the file list', ok([f(L + 'attachments.json', JSON.stringify([{ title: 'x', drive_file_id: '1zaxQFvbs2wp7Xq9NPW', type: 'pdf', html: '<b>' }]))]).ok, false],
    ['a bad Drive id in the file list', ok([f(L + 'attachments.json', JSON.stringify([{ title: 'x', drive_file_id: 'javascript:alert(1)', type: 'pdf' }]))]).ok, false],
    ['too big', ok([f(L + 'pic.png', '', { status: 'A', size: 3 * 1048576 })]).ok, false],
    ['auto_merge is reported from the config', checkChange(Object.assign({}, base, { teachers: { mona: Object.assign({}, teachers.mona, { auto_merge: true }) }, files: [f(L + 'attachments.json', '[]')] })).autoMerge, true],
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
  const res = checkChange({ teachers, branch: arg('branch'), author: arg('author'), lessons: baseLessons(base), files: fromGit(base, head) });
  if (res.ok) console.log(`OK: this pull request only adds or changes files on ${res.teacher}'s existing lessons.`);
  else { console.log(`REFUSED (${res.errors.length}):`); res.errors.forEach(e => console.log('  - ' + e)); }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${res.ok}\nauto_merge=${!!res.autoMerge}\nteacher=${res.teacher || ''}\n`);
  process.exit(res.ok ? 0 : 1);
}

module.exports = { checkChange, checkFileList, lessonFolders, pathProblem, selfTest };
if (require.main === module) main(process.argv.slice(2));
