// S4 requirements: the pure client rules (assets/requirements-logic.js).
//   node tests/test_req_logic.js            (run from tools/quiz-maker-v2)
const path = require('path');
const L = require(path.join(__dirname, '..', '..', '..', 'assets', 'requirements-logic.js'));
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x === undefined ? '' : JSON.stringify(x)))); };

// 1. defaults reproduce today's behaviour (the "default effective set" the guide asks a test to assert)
const cat0 = L.normalizeCatalog([]);
const eff0 = L.resolve(cat0, null);
const TODAY = {
  watch:           { enabled: true, in_monthly_report: true, parent_message: true,  rule: { pct: 80 }, weight: 1, source: 'default' },
  homework:        { enabled: true, in_monthly_report: true, parent_message: true,  rule: {}, weight: 1, source: 'default' },
  quiz:            { enabled: true, in_monthly_report: true, parent_message: true,  rule: {}, weight: 1, source: 'default' },
  attendance:      { enabled: true, in_monthly_report: true, parent_message: false, rule: {}, weight: 1, source: 'default' },
  written_answers: { enabled: true, in_monthly_report: true, parent_message: false, rule: {}, weight: 1, source: 'default' },
};
t('default effective set equals today (5 built-ins, watch 80, parent msg on watch/homework/quiz)', JSON.stringify(eff0) === JSON.stringify(TODAY), eff0);
t('default catalogue order is the frozen key order', JSON.stringify(cat0.map(c => c.key)) === JSON.stringify(['watch', 'homework', 'quiz', 'attendance', 'written_answers']));

// 2. precedence: default < global < group
const rows = [{ key: 'watch', enabled: true, in_monthly_report: true, parent_message: true, weight: 1, rule: { pct: 70 }, edited: true },
              { key: 'quiz', enabled: false, in_monthly_report: true, parent_message: true, weight: 1, rule: {}, edited: true }];
const cat1 = L.normalizeCatalog(rows);
t('global row beats default (watch 70, source global)', L.resolve(cat1, null).watch.rule.pct === 70 && L.resolve(cat1, null).watch.source === 'global');
t('global off flows to effective', L.resolve(cat1, null).quiz.enabled === false);
t('untouched built-in stays default', L.resolve(cat1, null).homework.source === 'default');
t('group off beats global on', L.resolve(cat1, { watch: { mode: 'off' } }).watch.enabled === false && L.resolve(cat1, { watch: { mode: 'off' } }).watch.source === 'group');
t('group on beats global off', L.resolve(cat1, { quiz: { mode: 'on' } }).quiz.enabled === true);
t('group custom rule beats global rule', L.resolve(cat1, { watch: { mode: 'custom', rule: { pct: 55 } } }).watch.rule.pct === 55);
t('group custom in_monthly_report false', L.resolve(cat1, { homework: { mode: 'custom', in_monthly_report: false } }).homework.in_monthly_report === false);
t('inherit changes nothing', JSON.stringify(L.resolve(cat1, { watch: { mode: 'inherit' } })) === JSON.stringify(L.resolve(cat1, null)));
t('override for another key does not leak', L.resolve(cat1, { watch: { mode: 'off' } }).homework.enabled === true);

// 3. validation
const V = (k, r) => L.validateRule(k, r);
t('watch pct 1..100 ok', V('watch', { pct: 1 }).ok && V('watch', { pct: 100 }).ok);
t('watch pct 0 refused', !V('watch', { pct: 0 }).ok);
t('watch pct 101 refused', !V('watch', { pct: 101 }).ok);
t('watch pct 70.5 refused', !V('watch', { pct: 70.5 }).ok);
t('watch pct "abc" refused', !V('watch', { pct: 'abc' }).ok);
t('watch pct "65" string accepted as 65', V('watch', { pct: '65' }).rule.pct === 65);
t('watch {} gets pct 80', V('watch', {}).rule.pct === 80);
t('quiz min_pct ok, empty ok', V('quiz', { min_pct: 60 }).ok && V('quiz', {}).ok);
t('unknown rule field refused', !V('homework', { pct: 50 }).ok && !V('watch', { min_pct: 50 }).ok);
t('rule must be an object', !V('watch', [80]).ok && !V('watch', 'x').ok);
t('custom key shape', L.isCustomKey('custom_behaviour') && !L.isCustomKey('custom_') && !L.isCustomKey('custom_Bad') && !L.isCustomKey('custom_a b') && !L.isCustomKey('behaviour') && !L.isCustomKey('custom_' + 'a'.repeat(41)));
t('slugFor', L.slugFor('Class behaviour!') === 'custom_class_behaviour' && L.slugFor('سلوك') === '' && L.slugFor('') === '');
t('weight 0..10', L.validWeight(0) && L.validWeight(10) && !L.validWeight(-1) && !L.validWeight(11) && !L.validWeight('1'));

// 4. custom requirements in the catalogue
const cat2 = L.normalizeCatalog([{ key: 'custom_behaviour', label_ar: 'سلوك', label_en: 'Behaviour', enabled: true, in_monthly_report: true, parent_message: false, weight: 2, sort: 1 },
                                 { key: 'custom_homework_neat', label_en: 'Neat', enabled: false, sort: 2 }]);
t('customs appended after built-ins, kind manual, per_month', cat2.length === 7 && cat2[5].key === 'custom_behaviour' && cat2[5].kind === 'manual' && cat2[5].scope === 'per_month' && cat2[5].weight === 2);
t('custom disabled flows through', L.resolve(cat2, null).custom_homework_neat.enabled === false);

// 5. preview helpers
t('monthlyList only enabled + in report', JSON.stringify(L.monthlyList(cat1, L.resolve(cat1, null)).map(x => x.key)) === JSON.stringify(['watch', 'homework', 'attendance', 'written_answers']));
t('differs() flags a changed rule', L.differs(L.resolve(cat1, { watch: { mode: 'custom', rule: { pct: 55 } } }).watch, L.resolve(cat1, null).watch) === true && L.differs(L.resolve(cat1, null).watch, L.resolve(cat1, null).watch) === false);
t('groupKey and phoneKey match the server rules', L.groupKey('  Sat   6PM ') === 'sat 6pm' && L.phoneKey('٠١٠٠٠٠٠٠٠٠٢') === '1000000002' && L.phoneKey('+20 100 000 0002') === '1000000002');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
