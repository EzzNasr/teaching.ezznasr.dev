// R-010  Center attendance grants only the group's current lesson, lapses at the end of that Cairo
// week (Sat-Fri), and undo removes only the rows it created. Clock frozen: Wed 2026-10-21 (Cairo).
// The expiry checks FAIL until Session 2 ships the weekly rule (pending:S2); the rest guard today's behaviour.
const { makeEnv, LESSONS } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const L = LESSONS.L2.now, OTHER = LESSONS.L3.now;
const f = makeEnv(); f.env.setNow('2026-10-21T12:00:00+03:00');
f.setVideo(L, 'AAAAAAAAAAA', true); f.setVideo(OTHER, 'BBBBBBBBBBB', true);
f.group('Sat 6pm', [f.P('sara'), f.P('omar')]);
f.saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: L, review_lessons: [] });
f.addEnt(f.P('sara'), L, '', 'manual');                          // teacher's own grant, must survive an undo
const att = (mode, who) => f.post({ action: 'admin_followup_set_attendance', token: 'tok', lesson: L, items: who.map(w => ({ phone: f.P(w), mode })) });
const entsOf = who => f.rows('Entitlements').filter(r => String(r.phone).endsWith(f.short(who)));
const can = (who, lesson) => ((f.overview().facts[f.short(who)] || {})[lesson] || {}).can_watch;

t('before: omar (no grant) cannot watch', can('omar', L) === false);
t('set_attendance center is accepted', att('center', ['omar']).ok === true);
t('center grants the current lesson', can('omar', L) === true);
t('center does NOT open another lesson', can('omar', OTHER) !== true);
const mine = entsOf('omar');
t('the grant is scoped to exactly the current lesson', mine.length === 1 && mine[0].scope === L, JSON.stringify(mine));
t('the grant carries a source tag so only it is undone later', !!mine[0].source && mine[0].source !== 'manual', JSON.stringify(mine[0]));
t('R-010 expiry: a center grant lapses at the end of the week (Fri 2026-10-23)', String(mine[0].expires_at).slice(0, 10) === '2026-10-23', 'expires_at=' + JSON.stringify(mine[0].expires_at));
att('center', ['sara']);
t('center for a student with their own manual grant does not duplicate or replace it', entsOf('sara').filter(r => r.source === 'manual').length === 1);
att('online', ['omar', 'sara']);
t('undo (online) removes the center row', entsOf('omar').length === 0, JSON.stringify(entsOf('omar')));
t('undo removes ONLY its own rows: the manual grant survives', entsOf('sara').length === 1 && entsOf('sara')[0].source === 'manual', JSON.stringify(entsOf('sara')));
t('after undo omar is locked again', can('omar', L) === false);
f.env.setNow('2026-10-24T09:00:00+03:00');   // Saturday: a new week
att('center', ['omar']);
const sat = entsOf('omar')[0] || {};
t('R-010 expiry: Saturday grants run to the NEXT Friday (2026-10-30)', String(sat.expires_at).slice(0, 10) === '2026-10-30', 'expires_at=' + JSON.stringify(sat.expires_at));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
