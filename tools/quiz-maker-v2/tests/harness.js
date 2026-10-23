// Minimal Apps Script mock — enough to run Code.gs's web-app actions.
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');

class Range {
  constructor(sh, r, c, nr, nc) {
    if (r < 1 || c < 1 || r + nr - 1 > sh.maxRows || c + nc - 1 > sh.maxCols)
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    Object.assign(this, { sh, r, c, nr, nc });
  }
  getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.get(this.r + i, this.c + j)); o.push(row);} return o; }
  getFormulas() { return this.getValues().map(r => r.map(() => '')); }
  setValues(v) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, v[i][j]); return this; }
  setValue(v) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, v); return this; }
  setNumberFormat() { return this; } setFontWeight() { return this; } setBackground() { return this; } setWrapStrategy() { return this; }
}
class Sheet {
  constructor(ss, name, id, maxRows = 1000, maxCols = 26) { Object.assign(this, { ss, name, id, maxRows, maxCols, cells: new Map() }); }
  get(r, c) { const v = this.cells.get(r + ',' + c); return v === undefined ? '' : v; }
  set(r, c, v) { this.cells.set(r + ',' + c, v); }
  getName() { return this.name; } getSheetId() { return this.id; } getParent() { return this.ss; }
  getMaxRows() { return this.maxRows; }
  getLastRow() { let m = 0; for (const [k, v] of this.cells) if (v !== '' && v != null) m = Math.max(m, +k.split(',')[0]); return m; }
  getLastColumn() { let m = 0; for (const [k, v] of this.cells) if (v !== '' && v != null) m = Math.max(m, +k.split(',')[1]); return m; }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getRangeList(list) { const rs = list.map(a => { const m = /^([A-Z]+)(\d+)$/.exec(a); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return this.getRange(+m[2], c); }); return { setNumberFormat() {} }; }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  appendRow(vals) { const r = this.getLastRow() + 1; if (r > this.maxRows) this.maxRows = r; vals.forEach((v, i) => { if (i + 1 > this.maxCols) this.maxCols = i + 1; this.set(r, i + 1, v); }); }
  insertRowsAfter(after, n) { this.maxRows += n; }
  // Like the real thing: the deleted rows go and everything below moves UP.
  deleteRows(start, n) { const moved = new Map(); for (const [k, v] of this.cells) { const [r, c] = k.split(',').map(Number); if (r >= start && r < start + n) continue; moved.set((r >= start + n ? r - n : r) + ',' + c, v); } this.cells = moved; this.maxRows -= n; }
  setFrozenRows() {} hideColumns() {} setColumnWidth() {} autoResizeColumn() {}
}
class Spreadsheet {
  constructor(id) { this.id = id; this.sheets = []; }
  getId() { return this.id; } getSheets() { return this.sheets; } getSpreadsheetTimeZone() { return 'Africa/Cairo'; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(this, n, this.sheets.length + 100); this.sheets.push(s); return s; }
}

function load(codeGsPath, opts = {}) {
  const store = {}, spreadsheets = {};
  // Test clock (Session 5). Default: real time, host Date, exactly as before. env.setNow(iso)
  // freezes "now" for code under test; env.setNow(null) goes back to real time.
  let nowMs = null;
  class ClockDate extends Date {
    constructor(...a) { if (a.length === 0 && nowMs !== null) super(nowMs); else super(...a); }
    static now() { return nowMs !== null ? nowMs : Date.now(); }
    static [Symbol.hasInstance](x) { return x instanceof Date; }   // host-made Dates still count
  }
  const props = { STUDENTS_SHEET_ID: 'STU', DATA_SHEET_ID: 'DATA', ADMIN_TOKEN: 'tok', SUBMISSIONS_FOLDER_ID: 'f', QUIZ_RESULTS_FOLDER_ID: 'f', ...(opts.props || {}) };
  const cache = {};
  const drive = { files: [], n: 0, createdWhileLocked: 0, onCreate: null };
  const lockState = { held: false, busy: false, waits: [] };
  const getSS = id => { if (!spreadsheets[id]) { const ss = new Spreadsheet(id); if (id === 'STU') ss.insertSheet('Students'); spreadsheets[id] = ss; } return spreadsheets[id]; };
  const fmtDate = (d, tz, pat) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
    if (pat === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
    if (pat === 'yyyy-MM-dd HH:mm:ss') return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
    return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}Z`;
  };
  const ctx = {
    console, Date: opts.clock ? ClockDate : Date, JSON, Math, parseInt, isNaN, String, Array, Object, Error, RegExp,
    Logger: { log: (...a) => (opts.log || (() => {}))(...a) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock(ms) { if (lockState.busy) throw new Error('Could not obtain lock after ' + ms + ' ms.'); lockState.held = true; lockState.waits.push(ms); }, releaseLock() { lockState.held = false; } }) },
    SpreadsheetApp: { openById: getSS, WrapStrategy: { CLIP: 1 } },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
    DriveApp: { Access: {}, Permission: {}, getFolderById: () => ({
      createFile: b => {
        if (lockState.held) drive.createdWhileLocked++;
        if (drive.onCreate) { const h = drive.onCreate; drive.onCreate = null; h(); }
        const f = { id: 'file' + (++drive.n), name: b && b.n, blob: b, sharing: null, trashed: false, getId() { return this.id; }, getName() { return this.name; }, getBlob() { return this.blob; }, setTrashed(v) { this.trashed = v; }, setSharing(a, p) { this.sharing = [a, p]; return this; } };
        drive.files.push(f); return f;
      },
      // Session 5 additions (new APIs only; existing behaviour unchanged)
      createFolder: n => ({ id: 'folder' + n, getId() { return 'folder' + n; }, getName() { return n; }, createFile(b) { return ctx.DriveApp.getFolderById('f').createFile(b); } }),
      getFoldersByName: () => ({ hasNext: () => false }),
      getFiles: () => ({ hasNext: () => false }) }), getFileById: id => { const f = drive.files.find(x => x.id === id); return f ? f : { makeCopy() {} }; } },
    Utilities: {
      formatDate: fmtDate,
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 1 },
      computeDigest: (alg, s) => [...crypto.createHash('md5').update(String(s)).digest()].map(b => (b > 127 ? b - 256 : b)),
      newBlob: (b, m, n) => ({ b, m, n, setName() {} }),
      base64Decode: s => Buffer.from(s, 'base64'),
      base64Encode: b => Buffer.from(b).toString('base64'),
    },
  };
  vm.createContext(ctx);
  // Apps Script shares one global scope across all .gs files, so load them all into one context.
  // Code.gs first, then (unless opts.phase2 === false) every Phase2_*.gs next to it, sorted by name.
  // Pass an array to choose the files yourself. Order must not matter (contract.md section 1).
  const files = Array.isArray(codeGsPath) ? codeGsPath.slice() : [codeGsPath];
  if (!Array.isArray(codeGsPath) && opts.phase2 !== false) {
    const dir = require('path').dirname(codeGsPath);
    fs.readdirSync(dir).filter(f => /^Phase2_.*\.gs$/.test(f)).sort().forEach(f => files.push(require('path').join(dir, f)));
  }
  // Layout-proof: Code.gs may have the Phase2_*.gs files merged into it, and the standalone copies may be deleted.
  // A missing Phase2_*.gs is skipped when Code.gs already defines that code; any other missing file is still an error.
  const merged = files.length && fs.existsSync(files[0]) && /^function p2_flag\b/m.test(fs.readFileSync(files[0], 'utf8'));
  files.forEach(f => {
    if (!fs.existsSync(f) && merged && /^Phase2_.*\.gs$/.test(require('path').basename(f))) return;
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: require('path').basename(f) });
  });
  const post = payload => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
  const setNow = iso => { if (!opts.clock) throw new Error("load(..., { clock: true }) is needed before setNow"); nowMs = iso === null ? null : new Date(iso).getTime(); };
  return { ctx, post, getSS, props, cache, drive, lockState, setNow, files };
}
module.exports = { load };
