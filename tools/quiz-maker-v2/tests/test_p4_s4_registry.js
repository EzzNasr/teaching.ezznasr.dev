// R-P4-S4-02: scripts/merge_registry_fragments.py on a temp registry with eight fragments.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const SITE = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(SITE, 'scripts', 'merge_registry_fragments.py');
const REAL_REG = path.join(__dirname, 'registry.json');
const py = ['python3', 'python', 'py'].find(c => { const r = cp.spawnSync(c, ['--version']); return !r.error && r.status === 0; });
let fails = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 400))); if (!ok) fails++; };
if (!py) { console.log('FAIL python not found'); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4reg-'));
const regPath = path.join(dir, 'registry.json');
const baseReg = JSON.parse(fs.readFileSync(REAL_REG, 'utf8'));
fs.writeFileSync(regPath, JSON.stringify(baseReg, null, 2) + '\n');
const entry = (n, k, status, extra) => Object.assign({ id: `R-P4-S${n}-${String(k).padStart(2, '0')}`, title: `session ${n} test ${k}`, status: status || 'active', needs: 'node', owner: 'p4-s' + n, cmd: ['node', `tests/test_p4_s${n}_x${k}.js`] }, extra || {});
for (let n = 1; n <= 8; n++) fs.writeFileSync(path.join(dir, `registry.p4-s${n}.json`), JSON.stringify({ entries: [entry(n, 1), entry(n, 2, n === 4 ? 'pending' : 'active')] }, null, 2) + '\n');
const run = (...a) => { const r = cp.spawnSync(py, [SCRIPT, '--registry', regPath, '--fragments', dir, ...a], { encoding: 'utf8' }); return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const reg = () => JSON.parse(fs.readFileSync(regPath, 'utf8'));
const before = baseReg.entries.length;

let r = run('--check');
t('--check before merging fails and names missing entries', r.status === 1 && /R-P4-S1-01 is in registry\.p4-s1\.json but not in the registry/.test(r.out), r.out);
t('--check wrote nothing', reg().entries.length === before);
r = run('--dry-run');
t('--dry-run reports and writes nothing', r.status === 0 && /16 added/.test(r.out) && reg().entries.length === before, r.out);
r = run();
t('merge exits 0 and adds 16 entries from 8 fragments', r.status === 0 && /16 added, 0 already present, 8 fragment/.test(r.out), r.out);
t('registry now has the 16 new entries after the old ones, old untouched', reg().entries.length === before + 16 && JSON.stringify(reg().entries.slice(0, before)) === JSON.stringify(baseReg.entries) && reg().entries[before].id === 'R-P4-S1-01', reg().entries.length);
const text = fs.readFileSync(regPath, 'utf8');
t('formatting kept: 2-space JSON, trailing newline, no CR', text === JSON.stringify(reg(), null, 2) + '\n' && !text.includes('\r'));
const bytes = fs.readFileSync(regPath);
r = run();
t('second merge is a no-op', r.status === 0 && /0 added, 16 already present/.test(r.out) && fs.readFileSync(regPath).equals(bytes), r.out);
r = run('--check');
t('--check passes after merging', r.status === 0, r.out);

// a different entry under an existing id is refused, never overwritten
const f1 = path.join(dir, 'registry.p4-s1.json');
const orig1 = fs.readFileSync(f1, 'utf8');
fs.writeFileSync(f1, JSON.stringify({ entries: [entry(1, 1, 'active', { title: 'changed title' }), entry(1, 2)] }));
r = run();
t('same id, different content -> exit 1, registry untouched', r.status === 1 && /R-P4-S1-01 differs/.test(r.out) && fs.readFileSync(regPath).equals(bytes), r.out);
fs.writeFileSync(f1, orig1);

// bad fragments
const bad = (name, frag, re) => { const f = path.join(dir, 'registry.p4-s9.json'); fs.writeFileSync(f, typeof frag === 'string' ? frag : JSON.stringify(frag)); const res = run(); fs.unlinkSync(f); t('bad fragment: ' + name, res.status === 1 && re.test(res.out) && fs.readFileSync(regPath).equals(bytes), res.out); };
bad('wrong id prefix', { entries: [entry(9, 1, 'active', { id: 'R-P4-S3-01' })] }, /must look like R-P4-S9-NN/);
bad('wrong owner', { entries: [entry(9, 1, 'active', { owner: 'p4-s3' })] }, /owner must be p4-s9/);
bad('bad status', { entries: [entry(9, 1, 'todo')] }, /status must be one of active\/pending/);
bad('no cmd', { entries: [entry(9, 1, 'active', { cmd: undefined })] }, /has no cmd/);
bad('duplicate id inside a fragment', { entries: [entry(9, 1), entry(9, 1)] }, /duplicate id R-P4-S9-01 inside/);
bad('not JSON', '{nope', /not valid JSON/);
bad('missing entries key', { list: [] }, /top level must be/);

// activate
r = run('--activate', 'R-P4-S4-*');
const s4 = reg().entries.filter(e => e.id.startsWith('R-P4-S4-'));
t('--activate R-P4-S4-* flips pending to active', r.status === 0 && s4.length === 2 && s4.every(e => e.status === 'active') && /R-P4-S4-02\s+-> active/.test(r.out), r.out);
t('--activate touched only those entries', reg().entries.filter(e => e.status === 'pending').length === baseReg.entries.filter(e => e.status === 'pending').length);
r = run();
t('re-merge after activation does not treat the activated entry as a conflict', r.status === 0, r.out);
r = run('--activate', 'R-NOPE-*');
t('--activate with no match fails', r.status === 1 && /matches no registry entry/.test(r.out), r.out);
r = run('--list');
t('--list prints the fragment entries', r.status === 0 && r.out.split('\n').filter(l => /^R-P4-/.test(l)).length === 16, r.out);

// the real repo: fragments dir without fragments is an error, not a silent success
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'p4regempty-'));
const re2 = cp.spawnSync(py, [SCRIPT, '--registry', regPath, '--fragments', empty], { encoding: 'utf8' });
t('no fragments at all -> exit 1', re2.status === 1 && /no registry\.p4-s\*\.json fragments found/.test(re2.stdout), re2.stdout);
process.exit(fails ? 1 : 0);
