// Phase 2 plumbing: router hook, feature flags, audit log, test clock, multi-file hygiene.
// Usage: node tests/test_phase2_core.js [apps_script dir]   (Session 5)
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const ACTIONS = ['admin_student_summary', 'admin_monthly_review', 'admin_set_requirement', 'admin_log_parent_notification', 'admin_list_parent_notifications', 'upload_written_image', 'get_quiz_review', 'admin_grading_queue', 'admin_grade_written', 'admin_migrate_lesson_keys'];
const CODE = path.join(dir, 'Code.gs'), CORE = path.join(dir, 'Phase2_Core.gs');
// Layout: Code.gs may have the Phase2_*.gs files MERGED into it (deploy = Code.gs alone). Detected by the handlers living in Code.gs.
const MERGED = /^function p2_admin_set_requirement\b/m.test(fs.readFileSync(CODE, 'utf8'));
const norm = x => x.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).filter(Boolean).join('\n');   // blank lines / trailing spaces don't count as drift

// --- router hook: only Code.gs + Core loaded, so no handler exists yet
{
  const env = load([CODE, CORE]);
  for (const a of ACTIONS) {
    const r = env.post({ action: a, token: 'tok' });
    if (MERGED) t('router: ' + a + ' is served by the merged Code.gs (never "not implemented")', !r.not_implemented, JSON.stringify(r));
    else t('router: ' + a + ' answers "not implemented" when its handler is absent', r.ok === false && r.not_implemented === true && /Not implemented yet/.test(r.error), JSON.stringify(r));
  }
  t('router: unknown action still unknown', /Unknown action/.test(env.post({ action: 'nope' }).error));
  // handler present: payload reaches it and the answer comes back untouched
  vm.runInContext('function p2_admin_set_requirement(p){ return { ok: true, echo: p.lesson }; }', env.ctx);
  const r = env.post({ action: 'admin_set_requirement', lesson: 'x' });
  t('router: a defined handler is called with the payload', r.ok === true && r.echo === 'x', JSON.stringify(r));
  // thrown errors keep the normal shape; a disabled flag adds disabled:true
  vm.runInContext('function p2_get_quiz_review(p){ p2_requireFlag("FF_DEFERRED_ANSWERS"); return { ok: true }; }', env.ctx);
  let r2 = env.post({ action: 'get_quiz_review' });
  t('flag off: {ok:false, disabled:true, error "Feature disabled: FF_..."}', r2.ok === false && r2.disabled === true && /Feature disabled: FF_DEFERRED_ANSWERS/.test(r2.error), JSON.stringify(r2));
  for (const v of ['1', 'true', 'TRUE']) { env.props.FF_DEFERRED_ANSWERS = v; t('flag on with "' + v + '"', env.post({ action: 'get_quiz_review' }).ok === true); }
  for (const v of ['0', 'false', '', 'yes', undefined]) { if (v === undefined) delete env.props.FF_DEFERRED_ANSWERS; else env.props.FF_DEFERRED_ANSWERS = v; t('flag off with ' + JSON.stringify(v), env.post({ action: 'get_quiz_review' }).disabled === true); }
  vm.runInContext('function p2_admin_grade_written(p){ throw new Error("boom"); }', env.ctx);
  const r3 = env.post({ action: 'admin_grade_written' });
  t('a throwing handler gives {ok:false, error} and no disabled flag', r3.ok === false && r3.error === 'boom' && !r3.disabled, JSON.stringify(r3));
}

// --- audit log
{
  const env = load([CODE, CORE]);
  t('audit returns true and creates the AuditLog tab with the contract header', env.ctx.p2_audit('0100', 'grade', 'sub1', { a: 1 }, { a: 2 }) === true &&
    JSON.stringify(env.getSS('DATA').getSheetByName('AuditLog').getRange(1, 1, 1, 6).getValues()[0]) === JSON.stringify(['at', 'who', 'action', 'target', 'before', 'after']));
  const sh = env.getSS('DATA').getSheetByName('AuditLog');
  t('audit row: objects stored as JSON, Cairo timestamp', sh.get(2, 5) === '{"a":1}' && sh.get(2, 6) === '{"a":2}' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0[23]:00$/.test(sh.get(2, 1)), [sh.get(2, 1), sh.get(2, 5)].join(' | '));
  env.ctx.p2_audit('0100', 'x', 'y');
  t('audit tolerates missing before/after', sh.get(3, 5) === '' && sh.get(3, 6) === '');
  delete env.props.DATA_SHEET_ID; env.props.DATA_SHEET_ID = null;
  let threw = false, res; try { res = env.ctx.p2_audit('w', 'a', 't'); } catch (e) { threw = true; }
  t('audit never throws, even when the data sheet is unreachable', !threw && typeof res === 'boolean');
}

// --- test clock
{
  const env = load(CODE, { clock: true });
  env.setNow('2026-10-24T10:00:00+03:00');
  const inCtx = vm.runInContext('new Date().toISOString() + "|" + Date.now()', env.ctx);
  t('clock: new Date() and Date.now() are frozen', inCtx === '2026-10-24T07:00:00.000Z|' + new Date('2026-10-24T07:00:00Z').getTime(), inCtx);
  t('clock: host-made Dates still pass instanceof Date in the context', vm.runInContext('(function(d){ return d instanceof Date; })', env.ctx)(new Date()) === true);
  t('clock: _cairoDate follows the frozen time', env.ctx._cairoDate(new env.ctx.Date()) === '2026-10-24', String(env.ctx._cairoDate(new env.ctx.Date())));
  env.setNow(null);
  t('clock: setNow(null) returns to real time', Math.abs(vm.runInContext('Date.now()', env.ctx) - Date.now()) < 5000);
  let msg = ''; try { load(CODE).setNow('2026-01-01'); } catch (e) { msg = e.message; }
  t('clock: setNow without {clock:true} fails loudly', /clock: true/.test(msg), msg);
}

// --- hygiene of every Phase2_*.gs (contract section 1)
{
  const gs = fs.readdirSync(dir).filter(f => /^Phase2_.*\.gs$/.test(f));
  if (!MERGED) t('Phase2_Core.gs exists', gs.includes('Phase2_Core.gs'));
  const names = f => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/gm)].map(m => m[1] || m[2]);
  // Contract v1.3: S1 and S4 shipped these names before integration. Waived by name (no collisions, tested above);
  // any NEW unprefixed global in a Phase2 file still fails. S2 and S3 must use p2f_ / p2c_.
  const LEGACY_UNPREFIXED = new Set(['MIGRATE_TARGETS', 'handleAdminMigrateLessonKeys', 'WM_HEADERS', 'WA_HEADERS', 'WA_EXTRA_HEADERS', 'GRADING_QUEUE_LIMIT', 'GRADING_MAX_MODEL_CHARS',
    '_gCanon', '_gKind', '_gModelsSheet', '_gAnswersSheet', '_gNum', '_gModelMap', '_gRecomputeAttempt', '_gAudit',
    'handleAdminSetWrittenModels', 'handleAdminGetWrittenModels', 'handleAdminGradingQueue', 'handleAdminGradeWritten', 'handleGetWrittenImage']);
  const owner = {}, dups = [], badPrefix = [], codeNames = new Set(names('Code.gs'));
  for (const f of ['Code.gs', ...gs]) for (const n of names(f)) {
    if (owner[n] && owner[n] !== f) dups.push(n + ' (' + owner[n] + ' & ' + f + ')'); else owner[n] = f;
    if (f !== 'Code.gs' && !/^(_p2|p2|P2_)/.test(n) && !LEGACY_UNPREFIXED.has(n)) badPrefix.push(f + ': ' + n);
  }
  if (MERGED) {
    // Merged layout: a Phase2_*.gs file is a source copy of a section of Code.gs. Same names in both is fine ONLY while the
    // copies are identical, so a fix made in one place and not the other fails here instead of silently winning in Apps Script.
    const codeSrc = norm(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8'));
    const drift = gs.filter(f => !codeSrc.includes(norm(fs.readFileSync(path.join(dir, f), 'utf8'))));
    t('merged Code.gs contains every Phase2_*.gs verbatim (no drift between the copies)', !drift.length, 'differs from Code.gs: ' + drift.join(', ') + '  -> run: python scripts/sync_phase2.py');
    const realDups = dups.filter(d => { const m = /\(([^&]+) & ([^)]+)\)/.exec(d); return m && !m.slice(1).some(f => gs.includes(f.trim())); });
    t('no global name is defined twice outside the merged copies', !realDups.length, realDups.join(', '));
  } else t('no global name is defined in two .gs files', !dups.length, dups.join(', '));
  t('every global in Phase2_*.gs starts with p2 / _p2 / P2_', !badPrefix.length, badPrefix.join(', '));
  for (const f of gs) {   // load alone in an EMPTY context: only declarations may run at load time
    let err = '';
    try { vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), vm.createContext({})); } catch (e) { err = e.message; }
    t(f + ' has no load-time dependencies (loads alone in an empty context)', !err, err);
  }
  const syntax = [];
  for (const f of ['Code.gs', ...gs]) { try { new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { syntax.push(f + ': ' + e.message); } }
  t('every .gs file parses', !syntax.length, syntax.join('; '));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
