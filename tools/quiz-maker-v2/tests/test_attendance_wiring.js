// Code.gs <-> attendance wiring: att_* actions reach att_dispatch_, and Telegram ad:/dd: taps reach att_decideFromTelegram_.
// Usage: node tests/test_attendance_wiring.js [apps_script dir]
const path = require('path'), vm = require('vm');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

const env = load(path.join(dir, 'Code.gs'));
vm.runInContext('var __seen = []; function att_dispatch_(p){ __seen.push(p.action); return { ok: true, echo: p.action, code: "X" }; }', env.ctx);
// 1. doPost routing
for (const a of ['att_ticket', 'att_signup', 'att_attend', 'att_rooms', 'att_roster', 'att_start_session', 'att_change_device']) {
  const r = env.post({ action: a });
  t('doPost routes ' + a + ' to att_dispatch_ (answer passes through untouched)', r.ok === true && r.echo === a && r.code === 'X', JSON.stringify(r));
}
t('a non-attendance unknown action is still "Unknown action"', /Unknown action/.test(env.post({ action: 'nope' }).error));
t('an action merely containing att_ is not routed', /Unknown action/.test(env.post({ action: 'xatt_ticket' }).error));

// 2. Telegram callbacks
env.props.TELEGRAM_WEBHOOK_SECRET = 'sec';
vm.runInContext(`
  var __log = [];
  function _tgAdminIds(){ return ["PAY"]; }
  function _tgCall(m, b){ __log.push(["pay", m, b]); }
  function att_tgAdminIds_(){ return ["111"]; }
  function att_tgCall_(m, b){ __log.push(["att", m, b]); }
  function att_decideFromTelegram_(id, ok){ __log.push(["decide", id, ok]); return "VERDICT-" + id; }
  function handleAdminDecidePayment(p){ __log.push(["payment", p.payment_id, p.decision]); }
`, env.ctx);
let uid = 0;
const tap = (data, from, secret) => {
  vm.runInContext('__log.length = 0', env.ctx);
  env.ctx.handleTelegramUpdate({ parameter: { tg: secret === undefined ? 'sec' : secret } },
    { update_id: ++uid, callback_query: { id: 'cb', from: { id: from }, data, message: { message_id: 5, chat: { id: from }, text: 'orig' } } });
  return JSON.parse(vm.runInContext('JSON.stringify(__log)', env.ctx));
};
let l = tap('ad:R-1', 111);
t('ad: by an attendance admin -> decide(R-1, approve) via the attendance bot', l.some(x => x[0] === 'decide' && x[1] === 'R-1' && x[2] === true) && l.every(x => x[0] !== 'pay'), JSON.stringify(l));
t('ad: spinner cleared + message edited with the verdict, on the attendance bot', l.some(x => x[0] === 'att' && x[1] === 'answerCallbackQuery') && l.some(x => x[0] === 'att' && x[1] === 'editMessageText' && /VERDICT-R-1/.test(x[2].text)), JSON.stringify(l));
l = tap('dd:R-2', 111);
t('dd: -> decide(R-2, deny)', l.some(x => x[0] === 'decide' && x[1] === 'R-2' && x[2] === false), JSON.stringify(l));
l = tap('ad:R-3', 999);
t('ad: from a non-admin is ignored', l.length === 0, JSON.stringify(l));
l = tap('ad:R-4', 'PAY');
t('ad: from a PAYMENTS admin who is not an attendance admin is ignored', l.length === 0, JSON.stringify(l));
l = tap('ad:R-5', 111, 'wrong');
t('wrong webhook secret is ignored', l.length === 0, JSON.stringify(l));
l = tap('ap:P-1', 'PAY');
t('ap: still approves a payment via the payments bot (unchanged)', l.some(x => x[0] === 'payment' && x[1] === 'P-1' && x[2] === 'approve') && l.some(x => x[0] === 'pay' && x[1] === 'editMessageText') && l.every(x => x[0] !== 'decide' && x[0] !== 'att'), JSON.stringify(l));
l = tap('rj:P-2', 'PAY');
t('rj: still rejects a payment', l.some(x => x[0] === 'payment' && x[2] === 'reject'), JSON.stringify(l));
l = tap('ap:P-3', 111);
t('a PAYMENTS tap from an attendance-only admin is ignored', l.length === 0, JSON.stringify(l));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
