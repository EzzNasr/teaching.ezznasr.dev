// The phone's own record of every message it touched, written to disk BEFORE and AFTER each send.
// It is what makes a crash safe: after a restart the sender knows which items it already tried, never sends them again,
// and still delivers any report the server has not received yet.
//   state per id: "attempt" (about to send / sending), "sent" (WhatsApp accepted it), "failed" (final), plus reported: true|false
"use strict";
const fs = require("fs"), path = require("path");

class Journal {
  constructor(file) {
    this.file = file;
    this.data = { items: {} };
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); if (!this.data.items) this.data.items = {}; } catch (e) { /* first run */ }
  }
  get(id) { return this.data.items[id] || null; }
  mark(id, patch) {
    const cur = this.data.items[id] || { first_at: new Date().toISOString() };
    this.data.items[id] = Object.assign(cur, patch, { at: new Date().toISOString() });
    this.save();
    return this.data.items[id];
  }
  /** Results the server has not acknowledged yet (sent / failed / retry with reported:false). */
  unreported() {
    return Object.keys(this.data.items).filter(id => {
      const x = this.data.items[id];
      return x.reported === false && (x.state === "sent" || x.state === "failed" || x.state === "retry");
    }).map(id => Object.assign({ id }, this.data.items[id]));
  }
  /** Ids that were being sent when the process stopped: the result is unknown. */
  interrupted() { return Object.keys(this.data.items).filter(id => this.data.items[id].state === "attempt"); }
  /** Keeps the file small: drops reported entries older than `days`. */
  prune(days) {
    const cut = Date.now() - days * 86400000;
    Object.keys(this.data.items).forEach(id => { const x = this.data.items[id]; if (x.reported && Date.parse(x.at) < cut) delete this.data.items[id]; });
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, JSON.stringify(this.data));
    fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, this.file);   // atomic on the same disk: a power cut leaves the old or the new file, never half of one
  }
}
module.exports = { Journal };
