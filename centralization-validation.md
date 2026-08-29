The repository now contains shared assets at `assets/theme.css`, `assets/theme.js`, `assets/base.css`, and `assets/forms.css`.

The Functions lesson loads successfully over HTTP with the centralized theme assets and preserves the existing lesson content, quiz, assignment, attachments, video, and WhatsApp action. Switching the page to dark mode updates the lesson page correctly.

Lesson pages now reference `/assets/base.css` and `/assets/forms.css` rather than local duplicate copies. The Grade 2 introductory session carries `class="track-two"` so it inherits the Grade 2 blue accent override.
