// A tiny DOM for the S7 tests. jsdom was not installed where this was written, so this implements just the
// pieces the dashboards and assets/draft-store.js use. It is a TEST helper (not run by the registry on its own).
// If jsdom is installed, the S7 tests still use this, so they behave the same everywhere.
const fs = require('fs'), path = require('path'), vm = require('vm');
const SITE = path.join(__dirname, '..', '..', '..');          // teaching.ezznasr.dev/

class TextNode { constructor(t) { this.nodeType = 3; this.textContent = String(t); this.parentNode = null; } }

class FNode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.childNodes = []; this.parentNode = null;
    this._attrs = {}; this._ls = {}; this.style = {}; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false;
    this.id = ''; this.type = ''; this.href = ''; this.title = ''; this.placeholder = ''; this.src = ''; this.onload = null; this.onerror = null;
    this.inputMode = ''; this.name = ''; this.htmlFor = '';
  }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
  get className() { return this._attrs.class || ''; }
  set className(v) { this._attrs.class = String(v); }
  get classList() {
    const self = this, list = () => (self._attrs.class || '').split(/\s+/).filter(Boolean);
    return { add(c) { const l = list(); if (l.indexOf(c) < 0) l.push(c); self._attrs.class = l.join(' '); }, remove(c) { self._attrs.class = list().filter(x => x !== c).join(' '); },
      contains(c) { return list().indexOf(c) >= 0; }, toggle(c, f) { const has = list().indexOf(c) >= 0; if (f === undefined ? !has : f) this.add(c); else this.remove(c); } };
  }
  get dataset() { const out = {}, self = this; Object.keys(this._attrs).forEach(k => { if (k.indexOf('data-') === 0) out[k.slice(5)] = self._attrs[k]; }); return out; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; if (String(v) !== '') this.appendChild(new TextNode(v)); }
  get innerHTML() { return this.childNodes.map(c => c.nodeType === 3 ? c.textContent : '<' + c.tagName.toLowerCase() + '>').join(''); }
  set innerHTML(v) { if (String(v) !== '') throw new Error('fake DOM: innerHTML may only be cleared (test guard against unescaped HTML)'); this.textContent = ''; }
  appendChild(c) {
    if (c.tagName === '#FRAGMENT') { c.childNodes.slice().forEach(k => this.appendChild(k)); return c; }
    if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; } return c; }
  insertBefore(c, ref) {
    if (c.tagName === '#FRAGMENT') { c.childNodes.slice().forEach(k => this.insertBefore(k, ref)); return c; }
    if (c.parentNode) c.parentNode.removeChild(c); const i = ref ? this.childNodes.indexOf(ref) : -1; c.parentNode = this; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) { this.childNodes[i] = n; n.parentNode = this; o.parentNode = null; } return o; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { v = String(v); this._attrs[k] = v; if (k === 'id') this.id = v; if (k === 'value') this.value = v; if (k === 'type') this.type = v; if (k === 'href') this.href = v; if (k === 'hidden') this.hidden = true; if (k === 'disabled') this.disabled = true; }
  getAttribute(k) { if (k === 'id') return this.id || null; return k in this._attrs ? this._attrs[k] : null; }
  hasAttribute(k) { return k in this._attrs || (k === 'hidden' && this.hidden); }
  removeAttribute(k) { delete this._attrs[k]; }
  addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
  removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter(x => x !== f); }
  dispatchEvent(e) { e.target = e.target || this; e.currentTarget = this; (this._ls[e.type] || []).slice().forEach(f => f.call(this, e)); return !e.defaultPrevented; }
  click() { this.dispatchEvent({ type: 'click', preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false }); }
  focus() {} blur() {} select() {} scrollIntoView() {} scrollTo() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  _walk(fn) { this.childNodes.forEach(c => { if (c.nodeType === 1) { fn(c); c._walk(fn); } }); }
  querySelectorAll(sel) {
    const parts = String(sel).split(',').map(s => s.trim()).filter(Boolean), out = [];
    const match = (n, p) => {
      let m = /^([a-zA-Z0-9]*)((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(p); if (!m) return false;
      if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
      const rest = m[2].match(/[#.][\w-]+|\[[^\]]+\]/g) || [];
      return rest.every(t => {
        if (t[0] === '#') return n.id === t.slice(1);
        if (t[0] === '.') return n.classList.contains(t.slice(1));
        const am = /^\[([\w:-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(t); if (!am) return false;
        return am[2] === undefined ? n.hasAttribute(am[1]) : n.getAttribute(am[1]) === am[2];
      });
    };
    this._walk(n => { if (parts.some(p => match(n, p))) out.push(n); });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementsByTagName(t) { return this.querySelectorAll(t); }
}

function makeStorage() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => m.clear(), get length() { return m.size; }, key: i => Array.from(m.keys())[i] || null }; }

// Build a window. html (optional) = a page; its static tags with an id, and its <a> tags, become flat children of <body>.
function makeDom(opts) {
  opts = opts || {};
  const documentElement = new FNode('html'), head = new FNode('head'), body = new FNode('body');
  documentElement.appendChild(head); documentElement.appendChild(body);
  const dls = {};
  const calls = { reloads: 0, hrefs: [], opened: [], confirms: [] };
  const win = {
    document: null, localStorage: makeStorage(), sessionStorage: makeStorage(), Promise, JSON, Date, Math, console, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { pathname: opts.path || '/dashboard/test.html', search: opts.search || '', href: '', reload() { calls.reloads++; } },
    history: { replaceState() {} }, scrollY: 0, scrollTo() {}, _ls: {}, confirmAnswer: true,
    addEventListener(t, f) { (win._ls[t] = win._ls[t] || []).push(f); }, removeEventListener(t, f) { win._ls[t] = (win._ls[t] || []).filter(x => x !== f); },
    dispatchEvent(e) { e.target = win; (win._ls[e.type] || []).slice().forEach(f => f.call(win, e)); return !e.defaultPrevented; },
    confirm(m) { calls.confirms.push(String(m)); return win.confirmAnswer; }, open(u) { calls.opened.push(u); return { closed: false }; },
    fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }), Event: function (type, init) { this.type = type; this.cancelable = !!(init && init.cancelable); this.defaultPrevented = false; this.preventDefault = () => { if (this.cancelable) this.defaultPrevented = true; }; },
    HTMLElement: FNode
  };
  Object.defineProperty(win.location, 'href', { get() { return this._h || ''; }, set(v) { this._h = v; calls.hrefs.push(v); } });
  const doc = {
    nodeType: 9, documentElement, head, body, readyState: 'complete', title: '',
    createElement: t => new FNode(t), createTextNode: t => new TextNode(t), createDocumentFragment: () => new FNode('#fragment'),
    getElementById: id => documentElement.querySelector('#' + id), querySelector: s => documentElement.querySelector(s), querySelectorAll: s => documentElement.querySelectorAll(s),
    addEventListener(t, f) { (dls[t] = dls[t] || []).push(f); }, removeEventListener() {},
    getElementsByTagName: t => documentElement.querySelectorAll(t)
  };
  win.document = doc; win.window = win; win.self = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  const dom = { window: win, document: doc, ctx, calls, FNode };
  dom.run = (code, name) => vm.runInContext(code, ctx, { filename: name || 'script.js' });
  dom.loadAsset = rel => dom.run(fs.readFileSync(path.join(SITE, rel), 'utf8'), rel);
  // static markup: elements with an id, plus <a> links (nav) and anything carrying data-* flags
  dom.loadHtml = html => {
    const bodyHtml = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) || [0, html])[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const re = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>(?:([^<]*)<\/\1>)?/g; let m;
    while ((m = re.exec(bodyHtml))) {
      const tag = m[1].toLowerCase(), attrs = m[2];
      if (!/\bid\s*=|\bdata-|^a$/.test(attrs + ' ' + tag) && tag !== 'a') continue;
      const n = new FNode(tag);
      attrs.replace(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g, (_, k, v) => { n.setAttribute(k, v === undefined ? '' : v); return ''; });
      if (m[3] && tag === 'a') n.textContent = m[3];
      body.appendChild(n);
    }
  };
  dom.fireDomReady = () => (dls.DOMContentLoaded || []).forEach(f => f());
  return dom;
}

// Wire script loading the way the dashboards do it: document.head.appendChild(<script src>) runs the file.
function wireScripts(dom, stubs) {
  const realAppend = dom.document.head.appendChild.bind(dom.document.head);
  dom.document.head.appendChild = function (n) {
    realAppend(n);
    if (n.tagName === 'SCRIPT' && n.src) {
      setTimeout(() => {
        const src = n.src.replace(/^\/?/, '/');
        try {
          if (stubs && stubs[src]) stubs[src](dom);
          else if (/\/assets\/(staff-guard|draft-store)\.js$/.test(src)) dom.loadAsset(src.slice(1));
          if (n.onload) n.onload();
        } catch (e) { if (n.onerror) n.onerror(e); }
      }, 0);
    }
    return n;
  };
}

const tick = (ms) => new Promise(r => setTimeout(r, ms || 5));
async function settle(n) { for (let i = 0; i < (n || 8); i++) await tick(2); }

module.exports = { makeDom, wireScripts, FNode, TextNode, tick, settle, SITE };
