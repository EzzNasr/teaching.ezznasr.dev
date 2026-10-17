// Watch tracker in video.js: runs the REAL makeWatchTracker text from the template and the
// live copy against simulated YouTube infoDelivery streams. Usage: node test_watch_tracker.js <site root>
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = process.argv[2] || path.join(__dirname, '..', '..', '..');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };

function extract(file) {
  const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const a = s.indexOf('// WATCH-TRACKER-BEGIN'), b = s.indexOf('// WATCH-TRACKER-END');
  if (a < 0 || b < 0) throw new Error('markers missing in ' + file);
  return s.slice(a, b);
}
function mem() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; }

function rig(file, storage) {
  const clock = { ms: 1000000 };
  const sends = [];
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(extract(file) + '\nthis.make = makeWatchTracker; this.C = {B: WT_BUCKET_S, STEP: WT_MAX_STEP_S, EVERY: WT_SEND_EVERY_MS};', ctx);
  const tr = ctx.make({ key: 'k', now: () => clock.ms, storage: storage || mem(), send: (p, d, u) => sends.push({ p, d, u }) });
  // play from..to seconds of a `dur`-second video, one infoDelivery per `step` s of video time (0.5 s wall each at 1x)
  const play = (from, to, dur, step = 1) => {
    tr.onInfo({ playerState: 1, duration: dur, currentTime: from });
    for (let x = from + step; x <= to + 1e-9; x += step) { clock.ms += 1000 * step; tr.onInfo({ playerState: 1, duration: dur, currentTime: x }); }
  };
  return { tr, sends, clock, play, ctx };
}

for (const [label, rel] of [['template', 'tools/quiz-maker-v2/assets_templates/video.js'], ['live copy', 'assets/video.js']]) {
  const file = path.join(root, rel);
  console.log('--- ' + label);

  { const r = rig(file); r.play(0, 600, 600);
    t(label + ': linear play of the whole video is ~100 %', r.tr.pct() >= 99, r.tr.pct()); }

  { const r = rig(file); r.tr.onInfo({ playerState: 1, duration: 600, currentTime: 0 }); r.tr.onInfo({ playerState: 1, duration: 600, currentTime: 590 });
    r.tr.onInfo({ playerState: 1, duration: 600, currentTime: 599 });
    t(label + ': skipping straight to the end is low', r.tr.pct() <= 3, r.tr.pct()); }

  { const r = rig(file); r.play(0, 60, 600); r.play(300, 360, 600);
    const p = r.tr.pct();
    t(label + ': seek back and forth counts only what was played', p >= 18 && p <= 24, p); }

  { const r = rig(file); r.play(0, 100, 600); const before = r.tr.pct(); r.play(0, 100, 600);
    t(label + ': re-watching the same part does not raise pct', r.tr.pct() === before, before + ' -> ' + r.tr.pct()); }

  { const r = rig(file); r.play(0, 100, 600);
    r.tr.onInfo({ playerState: 2, currentTime: 100 });
    const last = r.sends[r.sends.length - 1];
    t(label + ': pause reports immediately (urgent)', last && last.u === true && last.p === r.tr.pct(), JSON.stringify(last));
    const n = r.sends.length;
    r.tr.onInfo({ playerState: 1, currentTime: 100 }); r.tr.onInfo({ playerState: 2, currentTime: 100.2 });
    t(label + ': pause/resume with no new progress sends nothing', r.sends.length === n, r.sends.length + ' vs ' + n); }

  { const r = rig(file); r.play(0, 200, 600, 0.5);
    const gaps = r.sends.filter(s => !s.u).length;
    t(label + ': throttled to <= 1 send per 20 s while playing (200 s -> at most 10)', gaps >= 1 && gaps <= 10, gaps);
    t(label + ': sends carry pct only when it grew', r.sends.every((s, i) => i === 0 || s.p > r.sends[i - 1].p), JSON.stringify(r.sends.map(s => s.p))); }

  { const r = rig(file); r.play(0, 30, 600, 0.5);
    t(label + ': no send before pct reaches 1 and 20 s passed is false positive free', r.sends.every(s => s.p >= 1)); }

  { const st = mem(); const a = rig(file, st); a.play(0, 120, 600); a.tr.flush(true);
    const b = rig(file, st);
    t(label + ': refresh restores coverage from localStorage', b.tr.pct() === a.tr.pct() && b.tr.pct() > 0, a.tr.pct() + ' vs ' + b.tr.pct());
    b.play(120, 240, 600);
    t(label + ': ...and continues from there', b.tr.pct() > a.tr.pct(), b.tr.pct()); }

  { const r = rig(file, { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    let ok = true; try { r.play(0, 100, 600); r.tr.flush(true); } catch (e) { ok = false; }
    t(label + ': blocked localStorage never throws', ok && r.tr.pct() > 0); }

  { const st = mem(); st.setItem('k', '{not json');
    const r = rig(file, st); r.play(0, 50, 600);
    t(label + ': corrupt saved state is ignored', r.tr.pct() > 0); }

  { const r = rig(file, { getItem: () => null, setItem() {} }); r.tr = r.tr;
    const bad = []; r.ctx; 
    let thrown = false;
    const c2 = vm.createContext({}); vm.runInContext(extract(file) + '\nthis.make = makeWatchTracker;', c2);
    const tr = c2.make({ key: 'k', now: () => 0, storage: mem(), send: () => { throw new Error('net'); } });
    try { tr.onInfo({ playerState: 1, duration: 100, currentTime: 0 }); for (let i = 1; i < 100; i++) tr.onInfo({ playerState: 1, duration: 100, currentTime: i }); tr.flush(true); } catch (e) { thrown = true; }
    t(label + ': a failing send never breaks playback', !thrown); }

  { const r = rig(file); r.play(0, 60, 600); r.tr.onInfo({ playerState: 1, duration: 1200, currentTime: 0 });
    t(label + ': a different duration (other video) resets coverage', r.tr.pct() === 0, r.tr.pct()); }

  { const r = rig(file); r.tr.onInfo({ playerState: 2, duration: 600, currentTime: 50 }); r.tr.onInfo({ playerState: 3, currentTime: 55 });
    t(label + ': paused/buffering ticks cover nothing', r.tr.pct() === 0); }

  // wiring in the shipped file
  const src = fs.readFileSync(file, 'utf8');
  t(label + ': only lesson-slot, signed-in, non-admin viewers are tracked', /info\.kind !== "lesson"/.test(src) && /session\.is_admin\) return null/.test(src));
  t(label + ': attendance data goes to record_watch with keepalive on page exit', /action: "record_watch"/.test(src) && /keepalive: true/.test(src) && /pagehide/.test(src) && /visibilitychange/.test(src));
  t(label + ': attachControls receives the slot info and session', /attachControls\(slot, frame, info, session\)/.test(src));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
