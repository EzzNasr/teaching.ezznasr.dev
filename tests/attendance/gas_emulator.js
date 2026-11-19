// Minimal Apps Script emulator: loads the real .gs files into a vm context.
const vm = require("vm"), fs = require("fs"), crypto = require("crypto");
const GS_DIR = process.env.GS_DIR || require("path").join(__dirname, "..", "..", "tools", "quiz-maker-v2", "apps_script");
const signed = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const unsigned = arr => Buffer.from(arr.map(b => (b + 256) % 256));
function build() {
  const sheets = {}, props = { ADMIN_TOKEN: "adm-secret", ATT_TG_BOT_TOKEN: "NEWBOT:token", ATT_TG_ADMIN_IDS: "111" }, cache = {};
  let cacheShift = 0;
  const mkLock = () => { const l = { held: 0, tryLock() { l.held++; return true; }, waitLock() { l.held++; }, releaseLock() { if (l.held) l.held--; }, hasLock() { return l.held > 0; } }; return l; };
  const locks = { script: mkLock(), user: mkLock() };   // hasLock() is true only between tryLock and releaseLock, as in Apps Script   // gas.advance(ms) moves the CACHE clock forward (TTL expiry: login lock, 60 s user cache) without waiting
  // Telegram capture: gas.sent = messages (chat/text/markup/token), gas.tgCalls = every API call, gas.triggers = one-shot triggers created
  const sent = [], tgCalls = [], triggers = [];
  // Like real Google Sheets (2026-11-20, D26): a row the plain-text format ("@") does not cover turns digit-only text into a NUMBER
  // on write, so "0600925004" is stored as 600925004 (the leading zero is gone) and getValues returns a number. A row carries its
  // format (row._t); formats set on rows that do not exist yet are kept in _ahead; insertRowsAfter adds UNformatted rows.
  const coerce = v => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && v.replace(/[-.]/g, "").length < 16) ? Number(v) : v;
  class Sheet {
    constructor(n) { this.name = n; this._g = []; this._cols = 0; this._max = 1000; this._ahead = new Set(); }
    getLastRow() { return this._g.filter(r => r.some(c => c !== "")).length ? this._g.length : 0; }
    getLastColumn() { return this._g.reduce((m, r) => Math.max(m, r.length), 0); }
    getMaxRows() { return Math.max(this._max, this._g.length); }
    insertRowsAfter(after, n) { this._max = this.getMaxRows() + n; }
    setFrozenRows() {}
    _isText(i) { const row = this._g[i - 1]; return row ? !!row._t : this._ahead.has(i); }
    _row(i) { if (!this._g[i - 1]) { while (this._g.length < i) { const k = this._g.length + 1, row = []; if (this._ahead.has(k)) { row._t = true; this._ahead.delete(k); } this._g.push(row); } } return this._g[i - 1]; }
    appendRow(a) { const i = this._g.length + 1, text = this._isText(i), row = a.map(x => (text ? x : coerce(x))); if (text) { row._t = true; this._ahead.delete(i); } this._g.push(row); }
    _shift(n, k) { this._ahead = new Set([...this._ahead].map(i => (i > n ? i - k : i))); this._max = Math.max(1, this._max - k); }
    deleteRow(n) { this._g.splice(n - 1, 1); this._shift(n, 1); } deleteRows(n, k) { this._g.splice(n - 1, k); this._shift(n, k); }
    getRange(r, c, nr = 1, nc = 1) {
      const g = this._g, sh = this;
      const range = {
        getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (g[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? "" : v); } o.push(row); } return o; },
        setValues: v => { v.forEach((vals, i) => { const text = sh._isText(r + i), row = sh._row(r + i); vals.forEach((x, j) => { row[c - 1 + j] = text ? x : coerce(x); }); }); return range; },
        setValue: x => { const text = sh._isText(r), row = sh._row(r); row[c - 1] = text ? x : coerce(x); return range; },
        getValue: () => ((g[r - 1] || [])[c - 1] === undefined ? "" : g[r - 1][c - 1]),
        setNumberFormat: f => { if (f === "@") for (let i = r; i < r + nr; i++) { if (g[i - 1]) g[i - 1]._t = true; else sh._ahead.add(i); } return range; },
      };
      return range;
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
      getUuid: () => crypto.randomUUID(), sleep() {},
      formatDate: (d, tz, f) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache[k]; if (!e) return null; if (e.exp && e.exp <= Date.now() + cacheShift) { delete cache[k]; return null; } return e.v; },
      put: (k, v, ttl) => { cache[k] = { v, exp: ttl ? Date.now() + cacheShift + ttl * 1000 : 0 }; },
      remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => locks.script, getUserLock: () => locks.user },
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss },
    UrlFetchApp: {
      fetch: (url, opt) => {
        const m = /\/bot(.+?)\/(\w+)$/.exec(url), body = JSON.parse(opt.payload);
        tgCalls.push({ token: m[1], method: m[2], body });
        if (m[2] === "sendMessage") sent.push({ chat: String(body.chat_id), text: body.text, markup: body.reply_markup || null, token: m[1] });
        return { getResponseCode: () => 200 };
      },
    },
    ScriptApp: {
      newTrigger: fn => ({ timeBased: () => ({ after: ms => ({ create: () => { const t = { fn, ms, getHandlerFunction: () => fn }; triggers.push(t); return t; } }) }) }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    },
  };
  vm.createContext(ctx);
  // The DEPLOYED backend: AttendanceAll.gs (attendance, flags, Telegram, setup, accounts/login), loaded after Code.gs' own functions in the real project. apps_script/chunks/Att* are older copies and are NOT loaded.
  ["AttendanceAll.gs"].forEach(f => vm.runInContext(fs.readFileSync(GS_DIR + "/" + f, "utf8"), ctx, { filename: f }));
  return { ctx, sheets, props, sent, tgCalls, triggers, advance: ms => { cacheShift += ms; }, run: code => vm.runInContext(code, ctx) };
}
module.exports = { build };
