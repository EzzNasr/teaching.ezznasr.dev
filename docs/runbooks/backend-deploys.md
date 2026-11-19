# Backend deploys

*Written by `scripts/deploy_backend.js`, one row per scripted deploy (newest last). Commit this file after a deploy.
Roll back: `git checkout <commit of the previous row>` then `node scripts/deploy_backend.js --yes --allow-branch`.
Older, hand-pasted deploys are recorded in `docs/attendance/decisions.md`.*

| Date (Cairo) | Version | Commit | Previous version | Files changed | Result |
|---|---|---|---|---|---|
| 2026-11-16 13:34 | 70 | `1b53af0` | 69 | AttendanceAll, Code | smoke green |
