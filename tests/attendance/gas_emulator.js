// Minimal Apps Script emulator: loads the real .gs files into a vm context.
const vm = require("vm"), fs = require("fs"), crypto = require("crypto");
const GS_DIR = process.env.GS_DIR || "/mnt/user-data/outputs";
const signed = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const unsigned = arr => Buffer.from(arr.map(b => (b + 256) % 256));
function build() {
  const sheets = {}, props = { ADMIN_TOKEN: "adm-secret" }, cache = {};
  class Sheet {
    constructor(n) { this.name = n; this._g = []; this._cols = 0; }
    getLastRow() { return this._g.filter(r => r.some(c => c !== "")).length ? this._g.length : 0; }
    getLastColumn() { return this._g.reduce((m, r) => Math.max(m, r.length), 0); }
    getMaxRows() { return Math.max(1000, this._g.length); }
    setFrozenRows() {}
    appendRow(a) { this._g.push(a.slice()); }
    deleteRow(n) { this._g.splice(n - 1, 1); }
    getRange(r, c, nr = 1, nc = 1) {
      const g = this._g;
      return {
        getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (g[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? "" : v); } o.push(row); } return o; },
        setValues: v => { v.forEach((row, i) => { g[r - 1 + i] = g[r - 1 + i] || []; row.forEach((x, j) => { g[r - 1 + i][c - 1 + j] = x; }); }); },
        setValue: x => { g[r - 1] = g[r - 1] || []; g[r - 1][c - 1] = x; },
        getValue: () => ((g[r - 1] || [])[c - 1] === undefined ? "" : g[r - 1][c - 1]),
        setNumberFormat() {},
      };
    }
  }
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)) };
  const ctx = {
    console, Date, Logger: { log() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
      computeHmacSha256Signature: (v, k) => signed(crypto.createHmac("sha256", String(k)).update(String(v)).digest()),
      computeDigest: (alg, s) => signed(crypto.createHash("sha256").update(String(s)).digest()),
      base64EncodeWebSafe: s => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
      base64DecodeWebSafe: s => signed(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
      newBlob: arr => ({ getDataAsString: () => unsigned(arr).toString("utf8") }),
      getUuid: () => crypto.randomUUID(),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss },
  };
  vm.createContext(ctx);
  ["AttSetup.gs", "Attendance.gs", "AttStubs.gs"].forEach(f => vm.runInContext(fs.readFileSync(GS_DIR + "/" + f, "utf8"), ctx, { filename: f }));
  return { ctx, sheets, props, run: code => vm.runInContext(code, ctx) };
}
module.exports = { build };
