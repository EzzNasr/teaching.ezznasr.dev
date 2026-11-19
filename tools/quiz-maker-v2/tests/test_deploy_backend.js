// R-DEP-1: the scripted backend deploy (scripts/deploy_backend.js) and the version in the health check (doGet).
// Every git / clasp / gate / smoke command is faked, so nothing here touches Google or the live backend.
// Proves: a dry run changes nothing; drift, a dirty tree, a non-main commit and a different manifest stop the deploy
// before any push; a deploy runs push > verify > version > deployment > smoke in that order on the SAME deployment id;
// a failed smoke test rolls back to the previous version's files and version; the generated Version.gs feeds doGet.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const D = require(path.join(ROOT, 'scripts', 'deploy_backend.js'));
const { load } = require('./harness');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const throwsLike = async (fn, re) => { try { await fn(); return 'did not throw'; } catch (e) { return re.test(e.message) ? true : e.message; } };

// ---------- pure helpers ----------
check('deployedVersion reads @69 for the web-app id', D.deployedVersion('Found 2 deployments.\n- AKfyHEAD @HEAD \n- AKfyWEB @69 \n', 'AKfyWEB') === 69);
check('deployedVersion: an @HEAD-only id has no number', D.deployedVersion('- AKfyHEAD @HEAD', 'AKfyHEAD') === null);
check('createdVersion reads the new number', D.createdVersion('Created version 70.') === 70);
check('compare: CRLF and LF text is the same', D.compare({ a: 'x\r\ny\r\n' }, { a: 'x\ny' }).equal);
check('compare: a manifest with keys in another order is the same', D.compare({ 'appsscript.json': '{"a":1,"b":2}' }, { 'appsscript.json': '{"b":2,"a":1}' }).equal);
const cmp = D.compare({ a: '1', b: '2' }, { a: '1', c: '3' });
check('compare: names only on one side are reported', cmp.onlyA.join() === 'b' && cmp.onlyB.join() === 'c' && !cmp.equal);

const realCfg = D.loadConfig();
check('the real deploy.json loads (8 repo files + one generated Version)', realCfg.files.filter(f => f.repo).length === 8 && realCfg.files.some(f => f.generated === 'version'));
const rf = D.checkRepoFiles(realCfg);
check('deploy.json lists exactly the .gs files in apps_script/', rf.ok, JSON.stringify(rf));
check('the web-app deployment id in deploy.json is the endpoint the site calls',
  fs.readFileSync(path.join(ROOT, 'assets', 'assign.js'), 'utf8').indexOf(realCfg.deploymentId) !== -1);

const cfg = { scriptId: 'SID', deploymentId: 'DEPWEB', files: [{ repo: 'Code.gs', live: 'Code' }, { repo: 'Revenue.gs', live: 'Revenue.gs' }, { generated: 'version', live: 'Version' }] };
const MANIFEST = '{ "timeZone": "Africa/Cairo", "runtimeVersion": "V8" }';
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const st = D.stage(cfg, { commit: SHA, deployedAt: '2026-11-16 12:00', branch: 'main' }, f => f === 'appsscript.json' ? MANIFEST : 'src of ' + f);
check('stage keeps the editor names and order, Version last', JSON.stringify(st.clasp.filePushOrder) === JSON.stringify(['Code.gs', 'Revenue.gs.gs', 'Version.gs']));
check('stage: the push targets the configured script', st.clasp.scriptId === 'SID' && st.files['appsscript.json'] === MANIFEST);
check('stage: Version.gs carries the commit', /var APP_VERSION = \{"commit":"a{40}","short":"aaaaaaa"/.test(st.files['Version.gs']));

// ---------- the version in the health check (real Code.gs in the harness) ----------
const env = load(path.join(ROOT, 'tools', 'quiz-maker-v2', 'apps_script', 'Code.gs'));
const g1 = JSON.parse(env.ctx.doGet({}).text);
check('doGet without Version.gs: ok, version null (a hand-pasted deploy)', g1.ok === true && g1.version === null, JSON.stringify(g1));
require('vm').runInContext(st.files['Version.gs'], env.ctx);
const g2 = JSON.parse(env.ctx.doGet({}).text);
check('doGet with the generated Version.gs returns the commit and time', g2.version && g2.version.commit === SHA && g2.version.deployed_at === '2026-11-16 12:00', JSON.stringify(g2));

// ---------- the run, with every command faked ----------
function world(o = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploytest-'));
  const deployed = Object.assign({ 'Code.js': 'old code', 'Revenue.gs.js': 'src of Revenue.gs', 'appsscript.json': MANIFEST }, o.deployed || {});
  let saved = Object.assign({}, deployed, o.saved || {});
  const calls = [], logs = [];
  const writeDir = (dir, files) => Object.keys(files).forEach(n => fs.writeFileSync(path.join(dir, n), files[n]));
  const sh = (cmd, args, opts = {}) => {
    const c = cmd + ' ' + args.join(' '); calls.push(c);
    const r = out => ({ code: 0, out });
    if (c === 'git status --porcelain --untracked-files=no') return r(o.dirty ? ' M Code.gs' : '');
    if (c === 'git rev-parse HEAD') return r(SHA + '\n');
    if (c === 'git rev-parse --abbrev-ref HEAD') return r((o.branch || 'main') + '\n');
    if (c === 'git fetch --quiet origin') return r('');
    if (c.startsWith('git branch -r --contains')) return r(o.unpushed ? '' : '  origin/main\n');
    if (c === 'git rev-parse origin/main') return r((o.notMain ? OTHER : SHA) + '\n');
    if (cmd === 'bash') return { code: o.gateRed ? 1 : 0, out: o.gateRed ? 'BLOCKED' : 'ALL GREEN - safe to ship.' };
    if (c === 'clasp list-deployments SID') return r('- DEPHEAD @HEAD\n- DEPWEB @69 \n');
    if (c.startsWith('clasp clone SID')) { fs.writeFileSync(path.join(opts.cwd, '.clasp.json'), '{"scriptId":"SID"}'); writeDir(opts.cwd, saved); return r('Cloned'); }
    if (c === 'clasp pull --versionNumber 69') { writeDir(opts.cwd, deployed); return r('Pulled'); }
    if (c === 'clasp push --force') {
      const files = {}; fs.readdirSync(opts.cwd).filter(n => n !== '.clasp.json').forEach(n => { files[n === 'appsscript.json' ? n : n.replace(/\.gs$/, '') + '.js'] = fs.readFileSync(path.join(opts.cwd, n), 'utf8'); });
      if (o.badPush) files['Code.js'] = 'mangled';
      saved = files; return r('Pushed');
    }
    if (/^clasp (create-version|update-deployment)/.test(c) && !(opts.cwd && fs.existsSync(path.join(opts.cwd, '.clasp.json')))) throw new Error('Project settings not found.');   // real clasp needs .clasp.json in cwd
    if (c.startsWith('clasp create-version')) { if (o.versionFails) throw new Error('quota'); return r('Created version 70.'); }
    if (c.startsWith('clasp update-deployment')) return r('Deployed');
    if (cmd === 'node') return { code: o.smokeRed ? 1 : 0, out: o.smokeRed ? 'FAIL health check' : '14 pass, 0 fail' };
    throw new Error('unexpected command: ' + c);
  };
  const readRepo = f => f === 'appsscript.json' ? (o.manifest || MANIFEST) : f === 'Code.gs' ? 'new code' : 'src of ' + f;
  const deps = { sh, cfg, readRepo, tmp, say: () => {}, writeLog: row => logs.push(row), now: new Date('2026-11-16T10:00:00Z') };
  return { deps, calls, logs, saved: () => saved };
}
const writes = calls => calls.filter(c => /^clasp (push|create-version|update-deployment)/.test(c));

(async () => {
  let w = world();
  const dry = await D.run([], w.deps);
  check('dry run: reports the changed file (Code) and the previous version', dry.dryRun && dry.prev === 69 && dry.changes.join() === 'Code', JSON.stringify(dry));
  check('dry run: no push, no version, no deployment change', writes(w.calls).length === 0, writes(w.calls).join(' | '));

  w = world({ dirty: true });
  check('a dirty working tree stops before any clasp command', await throwsLike(() => D.run(['--yes'], w.deps), /uncommitted/) === true && !w.calls.some(c => c.startsWith('clasp')));
  w = world({ unpushed: true });
  check('a commit that is not on GitHub stops the deploy', await throwsLike(() => D.run(['--yes'], w.deps), /not on GitHub/) === true && writes(w.calls).length === 0);
  w = world({ notMain: true, branch: 'feature' });
  check('a commit that is not origin/main stops the deploy', await throwsLike(() => D.run(['--yes'], w.deps), /not origin\/main/) === true && writes(w.calls).length === 0);
  w = world({ notMain: true, branch: 'hotfix' });
  check('...unless --allow-branch is given on purpose', (await D.run(['--allow-branch'], w.deps)).dryRun === true);
  w = world({ gateRed: true });
  check('a red test gate stops the deploy', await throwsLike(() => D.run(['--yes'], w.deps), /not green/) === true && writes(w.calls).length === 0);
  w = world({ saved: { 'Code.js': 'edited in the editor' } });
  check('saved code that differs from the deployed version stops the deploy (triggers run it)', await throwsLike(() => D.run(['--yes'], w.deps), /saved code is not the deployed code/) === true && writes(w.calls).length === 0);
  w = world({ saved: { 'Code.js': 'edited in the editor' } });
  check('...unless --allow-drift is given on purpose', (await D.run(['--allow-drift'], w.deps)).dryRun === true);
  w = world({ manifest: '{ "timeZone": "Europe/London" }' });
  check('a manifest that differs from live stops the deploy', await throwsLike(() => D.run(['--yes'], w.deps), /manifest/) === true && writes(w.calls).length === 0);

  w = world();
  const ok = await D.run(['--yes'], w.deps);
  const order = w.calls.filter(c => /^clasp (push|clone|create-version|update-deployment)|^node /.test(c)).map(c => c.split(' ').slice(0, 2).join(' '));
  check('deploy order: clone, push, clone (verify), create-version, update-deployment, smoke',
    JSON.stringify(order) === JSON.stringify(['clasp clone', 'clasp push', 'clasp clone', 'clasp create-version', 'clasp update-deployment', 'node scripts/smoke_live.js']), order.join(' > '));
  check('the SAME deployment id is moved to the new version', w.calls.some(c => c === 'clasp update-deployment DEPWEB --versionNumber 70 --description aaaaaaa'));
  check('the smoke test is told which commit must be live', w.calls.some(c => c.indexOf('--expect-commit ' + SHA) !== -1));
  check('after the deploy the saved code is the repo code plus Version', w.saved()['Code.js'] === 'new code' && /APP_VERSION/.test(w.saved()['Version.js'] || ''));
  check('the deploy is recorded: version 70, commit, previous 69, files', ok.version === 70 && w.logs.length === 1 && /\| 70 \| `aaaaaaa` \| 69 \| Code \| smoke green \|/.test(w.logs[0]), w.logs[0]);

  w = world({ smokeRed: true });
  const why = await throwsLike(() => D.run(['--yes'], w.deps), /Rolled back/);
  check('a red smoke test rolls back and says so', why === true, why);
  check('...the previous version\'s files are pushed back (Version.gs gone)', w.saved()['Code.js'] === 'old code' && !('Version.js' in w.saved()), JSON.stringify(Object.keys(w.saved())));
  check('...and the deployment points at Version 69 again', w.calls.some(c => c === 'clasp update-deployment DEPWEB --versionNumber 69 --description rollback'));
  check('...and the rollback is recorded', w.logs.length === 1 && /ROLLED BACK to Version 69/.test(w.logs[0]), w.logs[0]);

  w = world({ badPush: true });
  check('a push that did not land as staged rolls back before any version is made',
    await throwsLike(() => D.run(['--yes'], w.deps), /Rolled back/) === true && !w.calls.some(c => c.startsWith('clasp create-version')));

  w = world({ versionFails: true });
  check('a failure while making the version rolls back too (saved code = Version 69 again)',
    await throwsLike(() => D.run(['--yes'], w.deps), /Rolled back/) === true && w.saved()['Code.js'] === 'old code');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL ' + e.stack); process.exit(1); });
