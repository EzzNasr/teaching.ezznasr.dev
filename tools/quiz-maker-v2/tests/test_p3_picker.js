// Phase 3 / S2: pure logic of assets/lesson-combobox.js (filtering, grouping, keyboard stepping).
const path = require('path');
const C = require(path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'), 'assets', 'lesson-combobox.js'));
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const it = { value: 'programming/baccalaureate/grade-2-secondary/chapter-2-lesson-1-cryptography', label: 'Ch 2 · L1 — Cryptography', group: 'الفصل 2', search: 'ch2 l1 c2l1 2.1' };
t('empty query matches everything', C.matches(it, ''));
t('title word matches', C.matches(it, 'crypto'));
t('shorthand "c2l1" matches', C.matches(it, 'c2l1'));
t('words in any order, all required', C.matches(it, 'l1 ch2') && !C.matches(it, 'l1 network'));
t('Arabic digits and alef variants are normalised', C.matches({ label: 'x', group: 'الفصل 2', value: 'v' }, 'الفصل ٢') && C.norm('أحمد') === C.norm('احمد'));
const runs = C.groupRuns([{ group: 'a', value: 1 }, { group: 'a', value: 2 }, { group: 'b', value: 3 }, { group: 'a', value: 4 }]);
t('groupRuns keeps arrival order, new run when the group changes', runs.length === 3 && runs[0].items.length === 2 && runs[2].group === 'a');
t('step wraps both ways, and starts at the ends', C.step(-1, 1, 3) === 0 && C.step(-1, -1, 3) === 2 && C.step(2, 1, 3) === 0 && C.step(0, -1, 3) === 2 && C.step(-1, 1, 0) === -1);
console.log('\n' + pass + ' pass, ' + fail + ' fail'); process.exit(fail ? 1 : 0);
