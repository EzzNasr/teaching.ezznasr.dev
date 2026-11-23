// R-P25-E: teacher publishing check (Phase 2.5 steps E and G).
//   node tests/test_p25_publish.js        (run from tools/quiz-maker-v2; needs git)
// 1. The rules on built-in examples (scripts/check_teacher_pr.js --self-test).
// 2. The check knows the owner's lessons: every lesson folder on main is found, and every attachments.json the owner
//    already has passes the file-list rule (the check never refuses a file list the Quiz Maker wrote).
// 3. The workflow is safe: pull_request_target, checks out the BASE commit, no credentials kept, the pull request's
//    branch name never inside a run: line, only teacher/ branches, auto-merge only when the config says so.
// 4. .github/teachers.json is valid and starts with auto-merge off.
// 5. End to end in a throw-away git repository: a teacher's branch that adds files to an existing lesson passes; a
//    branch that renames a lesson, adds, moves or deletes one, edits a lesson page, the grade page, sitemap.xml,
//    dashboard/, another subject, a workflow or his own rules is refused, each with a reason (names are fixed).
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const SITE = path.resolve(__dirname, '..', '..', '..');
const CHECK = path.join(SITE, 'scripts', 'check_teacher_pr.js');
const C = require(CHECK);
let fails = 0, passes = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 500))); ok ? passes++ : fails++; };
const git = (args, cwd) => execFileSync('git', args, { cwd: cwd || SITE, maxBuffer: 1 << 28 }).toString('utf8');

// 1
const selfRun = spawnSync(process.execPath, [CHECK, '--self-test'], { encoding: 'utf8' });
const lines = selfRun.stdout.split('\n').filter(Boolean);
t('rules self-test: every example behaves (' + lines.length + ' rules)', selfRun.status === 0 && lines.length >= 30 && lines.every(l => l.startsWith('PASS')), lines.filter(l => !l.startsWith('PASS')).join(' | '));

// 2
{
  const all = git(['ls-files']).split('\n').filter(Boolean);
  const lessons = C.lessonFolders(all);
  const subjects = ['programming', 'english', 'math', 'science'];
  const lists = all.filter(f => /(^|\/)attachments\.json$/.test(f) && subjects.includes(f.split('/')[0]));
  const missed = lists.filter(f => !lessons.has(f.slice(0, f.lastIndexOf('/') + 1)));
  t(`every lesson folder on main is found (${lessons.size} lessons)`, lessons.size > 20 && missed.length === 0, missed.slice(0, 3).join(' | '));
  const bad = [];
  lists.forEach(f => { const e = C.checkFileList(f, fs.readFileSync(path.join(SITE, f), 'utf8')); if (e.length) bad.push(e[0]); });
  t(`every attachments.json on main passes the file-list rule (${lists.length} lists)`, lists.length > 20 && bad.length === 0, bad.slice(0, 3).join(' | '));
}

// 3
{
  const wf = fs.readFileSync(path.join(SITE, '.github', 'workflows', 'teacher-publish.yml'), 'utf8');
  t('workflow: pull_request_target (rules come from main)', /^\s*pull_request_target:/m.test(wf) && !/^\s*pull_request:/m.test(wf));
  t('workflow: checks out the base commit, keeps no credentials', /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/.test(wf) && /persist-credentials: false/.test(wf));
  const runs = wf.split('\n').filter(l => /^\s*run:|^\s{10,}\S/.test(l) && !/^\s*(name|if|env|with|uses|ref|fetch-depth|persist-credentials|node-version|[A-Z_]+):/.test(l));
  t('workflow: no pull-request text expanded inside a shell line', !runs.some(l => /\$\{\{\s*github\.event\.pull_request\.(head\.ref|title|body|user)/.test(l)), runs.filter(l => /\$\{\{/.test(l)).join(' | '));
  t('workflow: only teacher/ branches', /if: startsWith\(github\.event\.pull_request\.head\.ref, 'teacher\/'\)/.test(wf));
  t('workflow: the pull request is fetched as data, never checked out or run', /refs\/pull\/\$\{PR\}\/head:refs\/remotes\/pr\/head/.test(wf) && !/npm (ci|install)|pip install|bash scripts\/test_all/.test(wf));
  t('workflow: auto-merge only when the check passed and the config says so', /if: steps\.check\.outputs\.ok == 'true' && steps\.check\.outputs\.auto_merge == 'true'/.test(wf));
  t('workflow: least permissions', /permissions:\s*\n\s*contents: read\s*\n\s*pull-requests: write/.test(wf));
  const tests = fs.readFileSync(path.join(SITE, '.github', 'workflows', 'test.yml'), 'utf8');
  t('tests workflow runs with a read-only token', /^permissions:\s*\n\s*contents: read/m.test(tests));
}

// 4
{
  const cfg = JSON.parse(fs.readFileSync(path.join(SITE, '.github', 'teachers.json'), 'utf8'));
  const ts = Object.entries(cfg.teachers || {});
  t('teachers.json: at least one teacher, valid handles and subjects', ts.length >= 1 && ts.every(([h, v]) => /^[a-z0-9][a-z0-9-]*$/.test(h) && Array.isArray(v.subjects) && v.subjects.length));
  t('teachers.json: every teacher starts with auto-merge off', ts.every(([, v]) => v.auto_merge === false));
  const sub = fs.readFileSync(path.join(SITE, 'tools', 'quiz-maker-v2', 'apps_script', 'Code.gs'), 'utf8').match(/^var P4_SUBJECTS = (\[[^\]]*\]);/m);
  t('teachers.json: every subject is a backend subject', !!sub && ts.every(([, v]) => v.subjects.every(s => JSON.parse(sub[1]).includes(s))));
}

// 5
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p25e-'));
  try {
    const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), s); };
    const g = args => git(args, tmp);
    g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@example.invalid']); g(['config', 'user.name', 't']); g(['config', 'core.autocrlf', 'false']);
    w('scripts/check_teacher_pr.js', fs.readFileSync(CHECK, 'utf8'));
    w('.github/teachers.json', JSON.stringify({ teachers: { mona: { name: 'Ms Mona', github: 'mona-gh', subjects: ['science'], auto_merge: false } } }));
    w('assets/quiz.js', '/* engine */'); w('assets/auth.js', '/* engine */');
    const G = 'science/secondary/grade-1-secondary/';
    const L = G + 'chapter-1-lesson-1/';
    w(G + 'index.html', '<html><body><div class="lessons"><a class="lesson" href="./chapter-1-lesson-1/">x</a></div></body></html>');
    w(L + 'index.html', '<html><body><h1>Chapter 1 Lesson 1</h1></body></html>');
    w(L + 'quiz.html', '<html><body>quiz</body></html>');
    w(L + 'assignment.html', '<html><body>assignment</body></html>');
    w(L + 'attachments.json', '[]');
    w('sitemap.xml', '<urlset><url><loc>https://x/</loc></url></urlset>');
    w('assets/lesson-titles.json', '{}');
    g(['add', '-A']); g(['commit', '-qm', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    const branch = (name, files, del) => {
      g(['checkout', '-q', '-B', name, base]);
      Object.entries(files).forEach(([p, s]) => w(p, s));
      (del || []).forEach(p => fs.rmSync(path.join(tmp, p), { recursive: true }));
      g(['add', '-A']); g(['commit', '-qm', name]);
      return g(['rev-parse', 'HEAD']).trim();
    };
    const run = (name, head, author) => spawnSync(process.execPath, [path.join(tmp, 'scripts', 'check_teacher_pr.js'), '--base', base, '--head', head, '--branch', name, '--author', author || 'mona-gh'], { cwd: tmp, encoding: 'utf8' });
    const list = JSON.stringify([{ title: 'Worksheet', drive_file_id: '1zaxQFvbs2wp7Xq9NPWUYDQVca66W8tQh', type: 'pdf' }], null, 2);
    let h = branch('teacher/mona/files', { [L + 'attachments.json']: list });
    let r = run('teacher/mona/files', h);
    t('git: adding a file to an existing lesson passes (attachments only)', r.status === 0 && /^OK/m.test(r.stdout), r.stdout + r.stderr);
    r = run('teacher/mona/files', h, 'someone-else');
    t('git: the same branch opened by another account is refused', r.status === 1 && /opened by "someone-else"/.test(r.stdout), r.stdout);
    h = branch('teacher/mona/pdf', { [L + 'worksheet.pdf']: '%PDF-1.4 x' });
    t('git: an attachment file in an existing lesson passes', run('teacher/mona/pdf', h).status === 0);
    const refusals = [
      ['rename', { [L + 'index.html']: '<html><body><h1>My own title</h1></body></html>' }, /chapter-1-lesson-1\/index\.html: lesson pages are made by the owner/],
      ['quiz-page', { [L + 'quiz.html']: '<html><body>new quiz</body></html>' }, /quiz\.html: lesson pages are made by the owner/],
      ['assignment-page', { [L + 'assignment.html']: '<html><body>new</body></html>' }, /assignment\.html: lesson pages are made by the owner/],
      ['new-lesson', { [G + 'chapter-1-lesson-9/index.html']: '<html></html>', [G + 'chapter-1-lesson-9/attachments.json']: '[]' }, /chapter-1-lesson-9\/index\.html: not inside an existing lesson; new lessons are added by the owner/],
      ['grade-page', { [G + 'index.html']: '<html><body>renamed</body></html>' }, /grade-1-secondary\/index\.html: grade and subject pages are made by the owner/],
      ['sitemap', { 'sitemap.xml': '<urlset><url><loc>https://x/science/secondary/grade-1-secondary/z/</loc></url></urlset>' }, /sitemap\.xml: outside/],
      ['titles', { 'assets/lesson-titles.json': '{"science/secondary/grade-1-secondary/chapter-1-lesson-1":"X"}' }, /assets\/lesson-titles\.json: outside/],
      ['dashboard', { 'dashboard/x.html': '<html></html>' }, /dashboard\/x\.html: outside your subject folders/],
      ['math', { 'math/x/quiz.html': '<html></html>' }, /math\/x\/quiz\.html: outside/],
      ['workflow', { '.github/workflows/x.yml': 'on: push' }, /\.github\/workflows\/x\.yml: outside/],
      ['rules', { '.github/teachers.json': '{"teachers":{"mona":{"github":"mona-gh","subjects":["science","math"],"auto_merge":true}}}' }, /\.github\/teachers\.json: outside/],
      ['engine', { 'assets/quiz.js': 'steal()' }, /assets\/quiz\.js: outside/],
      ['front', { 'science/index.html': '<html></html>' }, /science\/index\.html: grade and subject pages/],
      ['bad-list', { [L + 'attachments.json']: '[{"title":"x","drive_file_id":"javascript:alert(1)"}]' }, /entry 1 is not/],
    ];
    refusals.forEach(([n, files, re]) => {
      const hh = branch('teacher/mona/' + n, files);
      const rr = run('teacher/mona/' + n, hh);
      t('git: refused with a reason: ' + n, rr.status === 1 && /^REFUSED/m.test(rr.stdout) && re.test(rr.stdout), rr.stdout + rr.stderr);
    });
    h = branch('teacher/mona/remove', {}, [L.slice(0, -1)]);
    r = run('teacher/mona/remove', h);
    t('git: deleting a lesson is refused', r.status === 1 && /lesson pages are made by the owner/.test(r.stdout), r.stdout);
    g(['checkout', '-q', '-B', 'teacher/mona/move', base]); g(['mv', L.slice(0, -1), G + 'my-renamed-lesson']); g(['commit', '-qm', 'move']);
    r = run('teacher/mona/move', g(['rev-parse', 'HEAD']).trim());
    t('git: renaming a lesson folder is refused', r.status === 1 && /^REFUSED/m.test(r.stdout) && /my-renamed-lesson/.test(r.stdout), r.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
