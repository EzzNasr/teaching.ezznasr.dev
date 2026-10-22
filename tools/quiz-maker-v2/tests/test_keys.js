// S1: lesson-key aliases (R-003, R-005, R-020). Loads Code.gs + Phase2_Keys.gs together.
//   node tests/test_keys.js apps_script/Code.gs apps_script/Phase2_Core.gs apps_script/Phase2_Keys.gs
const fs = require('fs'), os = require('os'), pathMod = require('path'), crypto = require('crypto');
const { load } = require('./harness');
const tmp = pathMod.join(fs.mkdtempSync(pathMod.join(os.tmpdir(), 'keys-')), 'all.gs');
fs.writeFileSync(tmp, process.argv.slice(2).map(p => fs.readFileSync(p, 'utf8')).join('\n'));
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');

const G2 = 'programming/baccalaureate/grade-2-secondary/';
const NEW = [ 'chapter-1-lesson-1-development-of-information-technology-and-social-transformation', 'chapter-1-lesson-2-how-ai-works', 'chapter-1-lesson-3-ai-in-daily-life-and-industry' ].map(s => G2 + s);
const OLD = [ 'lesson-1-development-of-information-technology-and-social-transformation', 'lesson-2-how-ai-works', 'chaper-1-lesson-3-ai-in-daily-life-and-industry' ].map(s => G2 + s);
const ID = ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'];
const url = id => 'https://www.youtube.com/embed/' + id;

const env = load(tmp);
const { post, getSS, ctx } = env;
const tab = n => getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 14; c++) if (sh.get(1, c) === name) return c; return 0; };
const cell = (n, r, name) => tab(n).get(r, colOf(tab(n), name));
const setCell = (n, r, name, v) => tab(n).set(r, colOf(tab(n), name), v);
const TOK = { token: 'tok' };

// the three alias copies and the contract surface (integration, S5)
t('mirror: P2_LESSON_ALIASES equals Code.gs LESSON_ALIASES', JSON.stringify(Object.entries(ctx.P2_LESSON_ALIASES).sort()) === JSON.stringify(Object.entries(ctx.LESSON_ALIASES).sort()));
t('contract: p2k_canon agrees with _canonKey on every alias and on current keys', Object.keys(ctx.LESSON_ALIASES).concat(NEW, ['*', G2 + '*']).every(k => ctx.p2k_canon(k) === ctx._canonKey(k)));
t('contract: p2k_aliases lists canonical first and every old spelling', (a => a[0] === NEW[1] && a.includes(OLD[1]) && a.includes('lesson-2-how-ai-works'))(ctx.p2k_aliases(OLD[1])));
t('contract: p2k_same', ctx.p2k_same(OLD[2], NEW[2]) && !ctx.p2k_same(NEW[0], NEW[1]));

// canonicalizer itself
t('canon: old full path', ctx._canonKey(OLD[1]) === NEW[1]);
t('canon: typo path', ctx._canonKey(OLD[2]) === NEW[2]);
t('canon: bare slug -> full canonical key (contract section 2)', ctx._canonKey('lesson-2-how-ai-works') === NEW[1]);
t('canon: current key unchanged', NEW.every(k => ctx._canonKey(k) === k));
t('canon: wildcard / star / grade tag untouched', ctx._canonKey('*') === '*' && ctx._canonKey(G2 + '*') === G2 + '*' && ctx._canonKey('programming/baccalaureate/grade-2-secondary#ch1') === 'programming/baccalaureate/grade-2-secondary#ch1');
t('canon: unrelated lesson with same tail in another grade untouched', ctx._canonKey('programming/baccalaureate/grade-1-secondary/lesson-2-how-ai-works') === 'programming/baccalaureate/grade-1-secondary/lesson-2-how-ai-works');
t('_lessonPath resolves a request for the old key', ctx._lessonPath(OLD[0].toUpperCase() + '/') === NEW[0]);

// accounts
const reg = (phone, pw, name) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 2', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher'); const S = reg('01000000002', 'b', 'Sara');
const stu = getSS('STU').getSheetByName('Students'); stu.set(2, colOf(stu, 'is_admin'), true);
const ADMIN = { student_id: adm.student_id, session_token: adm.session_token };
const SA = { student_id: S.student_id, session_token: S.session_token };

NEW.forEach((k, i) => post(Object.assign({ action: 'admin_set_video', lesson: k, slot: 'lesson', video_url: url(ID[i]) }, TOK)));
const sees = (lesson, i) => post(Object.assign({ action: 'get_video', lesson, slot: 'lesson' }, SA)).embed_url === url(ID[i]);

// --- R-003: grants written under the OLD keys unlock the lesson under the NEW key -------------
t('no grant yet: locked', NEW.every((k, i) => !sees(k, i)));
post(Object.assign({ action: 'admin_grant_access', phone: '01000000002', scope: 'programming/other/x' }, ADMIN)); // creates the tab
const n0 = tab('Entitlements').getLastRow();
OLD.forEach((k, i) => { const r = n0 + 1 + i; tab('Entitlements').set(r, colOf(tab('Entitlements'), 'phone'), '01000000002'); tab('Entitlements').set(r, colOf(tab('Entitlements'), 'scope'), k); tab('Entitlements').set(r, colOf(tab('Entitlements'), 'expires_at'), ''); });
t('old-key / typo-key grants unlock the lessons under the new key', NEW.every((k, i) => sees(k, i)));
t('asking with the old key works too', OLD.every((k, i) => sees(k, i)));

// --- QuizAccess under old key -----------------------------------------------------------------
post(Object.assign({ action: 'admin_grant_quiz_access', phone: '01000000002', lesson: 'programming/other/y' }, ADMIN));
t('quiz access tab exists after a grant', !!tab('QuizAccess'));
const qr = tab('QuizAccess').getLastRow() + 1;
setCell('QuizAccess', qr, 'phone', '01000000002'); setCell('QuizAccess', qr, 'lesson', OLD[1]); setCell('QuizAccess', qr, 'expires_at', '');
t('quiz override stored under the old key counts for the new key', ctx._hasActiveQuizAccess(NEW[1], '01000000002') === true);
t('...and not for another lesson', ctx._hasActiveQuizAccess(NEW[0], '01000000002') === false);

// --- lock on the old key still locks (fail closed) ---------------------------------------------
post(Object.assign({ action: 'admin_set_lesson_lock', lesson: NEW[0], locked: true }, TOK));
{ const sh = tab('Lessons'); const idx = colOf(sh, 'lesson'); sh.set(2, idx, OLD[0]); }
t('a lock stored under the old key still applies to the new key', ctx._lessonLockedNow(NEW[0]) === true);
{ const sh = tab('Lessons'); sh.set(2, colOf(sh, 'lesson'), NEW[0]); }

// --- R-020: migration ---------------------------------------------------------------------------
// make Lessons conflict: an old-key row AND a new-key row
setCell('Lessons', 2, 'lesson', OLD[0]);
tab('Lessons').appendRow([NEW[0], true, '']);
const snap = () => JSON.stringify(['Entitlements', 'QuizAccess', 'Lessons'].map(n => [...tab(n).cells]));
const before = snap();
let r = post(Object.assign({ action: 'admin_migrate_lesson_keys' }, ADMIN));
t('migration: dry run by default', r.ok && r.dry_run === true, JSON.stringify(r));
t('migration: dry run lists the changes', r.changes.filter(c => c.tab === 'Entitlements').length === 3 && r.changes.some(c => c.tab === 'QuizAccess'), JSON.stringify(r.changes));
t('migration: dry run changed nothing and made no backups', snap() === before && !getSS('STU').sheets.some(s => /^bak_/.test(s.name)));
t('migration: a duplicate Lessons row is a conflict, not a rename', r.conflicts.length === 1 && r.conflicts[0].tab === 'Lessons' && !r.changes.some(c => c.tab === 'Lessons'), JSON.stringify(r.conflicts));
r = post(Object.assign({ action: 'admin_migrate_lesson_keys', apply: true }, ADMIN));
t('migration: apply rewrites', r.ok && r.dry_run === false && r.tabs_changed.includes('Entitlements') && r.tabs_changed.includes('QuizAccess'), JSON.stringify(r));
t('migration: Entitlements now hold the new keys', [0, 1, 2].every(i => cell('Entitlements', n0 + 1 + i, 'scope') === NEW[i]));
t('migration: backup tabs exist and hold the old keys', r.backups.length === r.tabs_changed.length && getSS('STU').getSheetByName(r.backups.find(b => /Entitlements/.test(b))).getDataRange().getValues().flat().includes(OLD[0]));
t('migration: conflicting Lessons row left alone', cell('Lessons', 2, 'lesson') === OLD[0]);
const afterOnce = snap(), nSheets = getSS('STU').sheets.length;
r = post(Object.assign({ action: 'admin_migrate_lesson_keys', apply: true }, ADMIN));
t('migration: running twice = running once (no changes, no new backups)', r.changes.length === 0 && snap() === afterOnce && getSS('STU').sheets.length === nSheets, JSON.stringify(r.changes));
t('migration: students still see the lessons afterwards', NEW.every((k, i) => sees(k, i)));
r = post({ action: 'admin_migrate_lesson_keys', session_token: 'x', student_id: SA.student_id, apply: true });
t('migration: refused for non-admins', !r.ok, JSON.stringify(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
