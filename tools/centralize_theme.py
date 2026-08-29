from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
THEME_LINK = '<link rel="stylesheet" href="/assets/theme.css">'
THEME_SCRIPT = '<script src="/assets/theme.js" defer></script>'

for path in ROOT.rglob('*.html'):
    if '.git' in path.parts:
        continue
    text = path.read_text(encoding='utf-8')

    # Every lesson, quiz, and assignment uses the single shared stylesheet pair.
    text = text.replace('href="./base.css"', 'href="/assets/base.css"')
    text = text.replace('href="./forms.css"', 'href="/assets/forms.css"')

    # Pages with a theme control use one synchronized controller.
    if 'id="theme-toggle"' in text:
        text = re.sub(
            r'\s*<script>\(function\(\)\{var root=document\.documentElement,toggle=document\.getElementById\(\'theme-toggle\'\).*?</script>',
            '', text, flags=re.S
        )
        if THEME_LINK not in text:
            text = text.replace('</head>', f'{THEME_LINK}\n</head>', 1)
        if THEME_SCRIPT not in text:
            text = text.replace('</head>', f'{THEME_SCRIPT}\n</head>', 1)

    # The second-year introductory lesson inherits the Grade 2 blue identity.
    if 'programming/baccalaureate/grade-2-secondary/' in str(path):
        text = re.sub(r'<body(?![^>]*track-two)', '<body class="track-two"', text, count=1)

    path.write_text(text, encoding='utf-8')

# Tokens are owned by theme.css; keep only the shared component rules in base.css.
base_path = ROOT / 'assets' / 'base.css'
base = base_path.read_text(encoding='utf-8')
base = re.sub(r':root\{.*?\n\}\nhtml\[data-theme="dark"\]\{.*?\n\}\n\n/\* ---- accent "tracks".*?\nhtml\[data-theme="dark"\] body\.track-two\{.*?\n', '', base, count=1, flags=re.S)
base_path.write_text(base, encoding='utf-8')
