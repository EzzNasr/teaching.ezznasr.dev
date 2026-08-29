from pathlib import Path
from urllib.parse import urlsplit
from bs4 import BeautifulSoup
import csv

ROOT = Path(__file__).resolve().parents[1]
rows = []


def resolve_target(source: Path, raw: str):
    raw = raw.strip()
    if not raw or raw.startswith(('#', 'mailto:', 'tel:', 'javascript:', 'data:', 'http://', 'https://', '//')):
        return None
    clean = urlsplit(raw).path
    if clean.startswith('/'):
        candidate = ROOT / clean.lstrip('/')
    else:
        candidate = source.parent / clean
    if clean.endswith('/') or candidate.is_dir():
        candidate = candidate / 'index.html'
    return candidate.resolve()

for source in sorted(ROOT.rglob('*.html')):
    if '.git' in source.parts or 'tools' in source.parts:
        continue
    soup = BeautifulSoup(source.read_text(encoding='utf-8'), 'html.parser')
    for tag in soup.find_all(['a', 'link', 'script', 'img', 'source', 'iframe']):
        attr = 'href' if tag.name in ('a', 'link') else 'src'
        raw = tag.get(attr)
        if not raw:
            continue
        target = resolve_target(source, raw)
        if target is None:
            continue
        exists = target.is_file()
        kind = 'navigation' if tag.name == 'a' else 'asset'
        rows.append({
            'source': str(source.relative_to(ROOT)),
            'tag': tag.name,
            'kind': kind,
            'raw': raw,
            'resolved': str(target.relative_to(ROOT)) if target.is_relative_to(ROOT) else str(target),
            'exists': 'yes' if exists else 'NO',
        })

out = ROOT / 'path-audit.csv'
with out.open('w', newline='', encoding='utf-8') as fh:
    writer = csv.DictWriter(fh, fieldnames=['source', 'tag', 'kind', 'raw', 'resolved', 'exists'])
    writer.writeheader()
    writer.writerows(rows)

missing = [r for r in rows if r['exists'] == 'NO']
nav = [r for r in rows if r['kind'] == 'navigation']
asset = [r for r in rows if r['kind'] == 'asset']

report = ROOT / 'path-audit.md'
with report.open('w', encoding='utf-8') as fh:
    fh.write('# HTML Path Audit\n\n')
    fh.write(f'Checked {len(rows)} local references across {len(list(ROOT.rglob("*.html")))} HTML files.\n\n')
    fh.write(f'- Navigation references checked: {len(nav)}\n')
    fh.write(f'- Asset references checked: {len(asset)}\n')
    fh.write(f'- Missing targets: {len(missing)}\n\n')
    if missing:
        fh.write('## Missing targets\n\n| Source | Reference | Resolved target | Type |\n|---|---|---|---|\n')
        for r in missing:
            fh.write(f'| `{r["source"]}` | `{r["raw"]}` | `{r["resolved"]}` | {r["kind"]} |\n')
    else:
        fh.write('All local navigation and asset references resolve to existing files.\n')

print(f'checked={len(rows)} navigation={len(nav)} assets={len(asset)} missing={len(missing)}')
for r in missing:
    print(f'MISSING\t{r["source"]}\t{r["raw"]}\t{r["resolved"]}')
