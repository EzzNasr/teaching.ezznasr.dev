// A small fetch() for the phone that survives dead Google addresses.
// Found on the first setup (2026-11-05): from the home connection some of Google's address ranges (142.250.x) never answer,
// and the system DNS sometimes hands out only those, so plain fetch() fails with a connect timeout for minutes at a time.
// This one asks two public DNS servers as well, and lets Node try every address in turn (autoSelectFamily) until one connects.
// Only the CONNECTION is retried on another address: a request that was already sent is never sent again (W5, never twice).
"use strict";
const https = require("https"), dns = require("dns");

// Second fix (same day): DNS can still answer with ONLY the dead address plus IPv6 (the home network has no IPv6). So:
//   - IPv6 is left out (every attempt was ENETUNREACH);
//   - addresses that connected are REMEMBERED (data/net-memory.json, survives restarts) and tried first, even when DNS
//     does not mention them this time; addresses that failed go to the back for an hour.
const fs = require("fs"), path = require("path");
const MEM_FILE = path.join(__dirname, "..", "data", "net-memory.json");
const BAD_MS = 3600000, KEEP_GOOD = 8;

const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

let mem = { good: {}, bad: {} };   // good: host -> [address, newest first]; bad: address -> time it failed
try { mem = Object.assign(mem, JSON.parse(fs.readFileSync(MEM_FILE, "utf8"))); } catch (e) { /* first run */ }
function saveMem() { try { fs.mkdirSync(path.dirname(MEM_FILE), { recursive: true }); fs.writeFileSync(MEM_FILE, JSON.stringify(mem)); } catch (e) { /* not fatal */ } }
function rememberGood(host, address) {
  if (!host || !address) return;
  const list = (mem.good[host] || []).filter(a => a !== address);
  list.unshift(address); mem.good[host] = list.slice(0, KEEP_GOOD); delete mem.bad[address]; saveMem();
}
function rememberBad(address) { if (address) { mem.bad[address] = Date.now(); saveMem(); } }
const isBad = a => mem.bad[a] && Date.now() - mem.bad[a] < BAD_MS;

/** The addresses to try, in order: remembered good ones, then fresh DNS answers, then recently failed ones (IPv4 only). */
function order(host, fresh) {
  const seen = new Set(), all = [];
  (mem.good[host] || []).concat(fresh).forEach(a => { if (a && !seen.has(a) && !a.includes(":")) { seen.add(a); all.push(a); } });
  return all.filter(a => !isBad(a)).concat(all.filter(isBad));
}

function lookupAll(host, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  let pending = 2, sys = [], pub = [], err = null;
  const done = () => {
    if (--pending) return;
    // public-DNS IPv4 first (that is where the working addresses came from), then the system's answers
    const out = order(host, pub.concat(sys.filter(a => a.family === 4).map(a => a.address))).map(a => ({ address: a, family: 4 }));
    if (!out.length) return cb(err || new Error("no IPv4 address for " + host));
    if (opts && opts.all) cb(null, out); else cb(null, out[0].address, out[0].family);
  };
  dns.lookup(host, { all: true }, (e, a) => { if (e) err = e; else sys = a || []; done(); });
  resolver.resolve4(host, (e, a) => { if (e) err = err || e; else pub = a || []; done(); });
}

// Trying every address ends, when all of them fail, in an AggregateError with an EMPTY message: name the addresses instead.
function explain(e) {
  if (e && e.message) return e;
  const parts = ((e && e.errors) || []).map(x => (x.code || x.message || "?") + (x.address ? " " + x.address : ""));
  return new Error("could not connect" + (parts.length ? ": " + parts.join(", ") : (e && e.code ? ": " + e.code : "")));
}

function once(url, opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: opts.method || "GET", headers: opts.headers || {}, lookup: lookupAll,
      autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 2500, timeout: 60000,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    const host = new URL(url).hostname;
    req.on("socket", s => s.once("secureConnect", () => rememberGood(host, s.remoteAddress)));
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", e => {
      ((e && e.errors) || [e]).forEach(x => { if (x && x.address && /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(x.code || "")) rememberBad(x.address); });
      reject(explain(e));
    });
    if (opts.signal) opts.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** fetch-like: (url, {method, headers, body, signal}) -> {status, text()}. Follows redirects the way fetch does (303/302 after POST -> GET). */
async function phoneFetch(url, opts) {
  opts = opts || {};
  let r = await once(url, opts);
  for (let hops = 0; r.status >= 300 && r.status < 400 && r.location && hops < 5; hops++) {
    url = new URL(r.location, url).toString();
    r = await once(url, { method: "GET", signal: opts.signal });
  }
  return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body };
}

module.exports = { phoneFetch, lookupAll, order, _mem: () => mem };
