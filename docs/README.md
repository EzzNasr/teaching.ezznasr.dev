# Docs

Start with [ARCHITECTURE.md](ARCHITECTURE.md): how the site, the backend and the desktop app fit together, and the rules every
new feature follows.

## Map

| Folder / file | What is in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System map, data flow, design principles, the checklist for a new feature |
| [TESTING.md](TESTING.md) | The test gate (`scripts/test_all.sh`) and what GitHub Actions runs |
| [REGRESSION.md](REGRESSION.md) | Every registered test (generated from `tools/quiz-maker-v2/tests/registry.json`: do not edit by hand) |
| [contract.md](contract.md) | The shared data contract between the site, `Code.gs` and the app (lesson ids, actions, payloads) |
| [rollout-checklist.md](rollout-checklist.md) | Shipping a site + Apps Script release |
| [attendance/](attendance/README.md) | The attendance system: decisions, deploy, load testing, live-testing plan, demo data, screenshots |
| [whatsapp/](whatsapp/README.md) | The WhatsApp sender on the spare phone: decisions, setup on the Y7 Prime, safety, phase 2 |
| [runbooks/](runbooks/) | How to operate and deploy the other features: follow-up v2, notifications, Phase 3 (roles, flags), upload guard |
| [specs/](specs/) | Design specs of current features: dashboards data contract, grade subscriptions, follow-up dashboard |
| [history/](history/) | Integration log and early hand-offs, kept for context |

## Where a doc goes

| Inside this repo (`docs/`, **public**) | Outside the repo (`Docs/` next to it, **private**) |
|---|---|
| Anything that must change when the code changes: architecture, contracts, decisions, runbooks, specs of what exists, test docs, screenshots of the product | Plans and proposals not built yet, pricing, customers, status reports for the owner, **known security gaps**, session deliverables (zips, bundles), archives |
| Reviewed in the same commit as the code | Kept private; linked by name from here when needed |

Rules:
- **One topic, one place.** Update the existing page instead of writing a new one next to it.
- **Decisions get a number** (D# in the feature's `decisions.md`): what, why, when to revisit. Follow-ups get an F#.
- **Every deploy gets a line** in the feature's deploy record, with the rollback version.
- **No secrets, personal data or open vulnerabilities** in this folder: the repo is public. Screenshots use sample data.
- **Generated files say so** at the top and are never edited by hand (`REGRESSION.md`).
- Older pages name other docs by bare file name (for example `PROJECT_HISTORY.md`): those live in the external `Docs/` folder
  (`01-overview/`, `03-history/`).
