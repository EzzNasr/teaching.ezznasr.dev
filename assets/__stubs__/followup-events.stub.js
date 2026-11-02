/* followup-events.stub.js — TEST ONLY, never shipped (Follow-up v2, S1).
 *
 * A contract-shaped stand-in for S3's assets/followup-events.js (guide section 3.2) so the page can be built
 * and tested before S3 merges. It does NOT compute anything: it returns the answers written into the mock
 * fixture (overview._stub_events[group_key], filled by ?mock=1&scenario=<name>), and "all_clear" otherwise.
 * e2e_followup_v2.py serves this file in place of /assets/followup-events.js when asked to (stub mode).
 */
(function (root) {
  "use strict";
  var ORDER = ["attendance", "parents_watch", "parents_hw", "remind_watch", "remind_hw", "advance_lessons", "setup_missing"];
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function eventsFor(overview, groupKey) {
    var g = ((overview && overview.groups) || []).filter(function (x) { return x.key === groupKey; })[0];
    if (!g) return null;
    var canned = overview._stub_events && overview._stub_events[groupKey];
    var out = canned ? clone(canned) : { group_key: groupKey, tz_label: "Alex", prev_session: null, next_session: null, phase: "all_clear", next_event_at_iso: null, events: [] };
    out.group = g.group;
    out.events.sort(function (a, b) { return ORDER.indexOf(a.key) - ORDER.indexOf(b.key); });
    // honour "done" the way the real engine does for the manual events, so the page's buttons can be tested
    var MAN = { remind_watch: "watch", remind_hw: "hw", advance_lessons: "advance" };
    out.events.forEach(function (e) { if (MAN[e.key] && (g.done || []).indexOf(MAN[e.key] + "|" + e.session_date) >= 0) e.state = "done"; });
    var due = out.events.filter(function (e) { return e.state === "due"; });
    out.phase = due.length ? due[0].key : "all_clear";
    return out;
  }
  function dueNow(overview) {
    var res = [];
    ((overview && overview.groups) || []).forEach(function (g) {
      var r = eventsFor(overview, g.key);
      (r.events || []).forEach(function (e) { if (e.state === "due" && e.count > 0) res.push({ group_key: g.key, group: g.group, key: e.key, session_date: e.session_date, count: e.count, student_keys: e.student_keys || [], lesson: e.lesson, blocked_count: e.blocked_count || 0 }); });
    });
    return res;
  }
  var api = { eventsFor: eventsFor, dueNow: dueNow, TZ_LABEL: "Alex", NOTIFY_HOUR_DEFAULT: 16, STUB: true };
  if (typeof module === "object" && module.exports) module.exports = api; else root.FollowupEvents = api;
}(typeof self !== "undefined" ? self : this));
