# Teacher photos

The home-page transition and the photo card on each subject's front page (`programming/`, `math/`, `science/`, `english/`) read the teacher's name and photo from **one file: `assets/teachers.js`** (the `TEACHERS` list at the top).

Today every subject shows a marked placeholder silhouette (`assets/teachers/placeholder-<subject>.svg`, it says "PHOTO PLACEHOLDER").

## Swapping in a real photo

The repo is **public**. Only add a photo the owner has approved for publishing.

1. Put the photo in `assets/teachers/`, for example `assets/teachers/science.jpg`: portrait (3:4, about 600 x 800), under 200 KB, no location data (EXIF stripped).
2. In `assets/teachers.js`, for that subject set `photo: '/assets/teachers/science.jpg'` and `placeholder: false`. Fix `name` / `nameAr` there too if needed.

That is all. The `<img>` written in each subject page only shows when JavaScript is off; it can keep the placeholder (or be updated at the same time if you want the no-JS view to match).

## Other knobs in `assets/teachers.js`

- `INTRO_MS`: how long the home-page transition lasts (0.8 s: a small teacher card over a dimmed page; the owner found the 1.5 s full-screen version too heavy).

Test: R-TEACH-1 (`tools/quiz-maker-v2/tests/e2e_teacher_pages.py`).
