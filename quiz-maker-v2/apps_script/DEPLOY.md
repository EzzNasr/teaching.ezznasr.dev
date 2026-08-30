# Deploying the Drive bridge

One Apps Script Web App, running under your own Google account. No billing,
no server to maintain — it's already covered by your normal Google account
quota.

1. **Create two Drive folders** (anywhere in your own Drive):
   - `Teaching / Attachments` — files you upload for students to view
   - `Teaching / Submissions` — where student work lands
   Open each and copy the folder ID out of the URL:
   `drive.google.com/drive/folders/`**`THIS_PART`**

2. **Create the script**
   - Go to [script.google.com](https://script.google.com) → New project
   - Delete the default `Code.gs` contents, paste in this repo's
     `apps_script/Code.gs`
   - Project Settings (gear icon) → Script Properties → add:
     | Property | Value |
     |---|---|
     | `ATTACHMENTS_FOLDER_ID` | folder ID from step 1 |
     | `SUBMISSIONS_FOLDER_ID` | folder ID from step 1 |
     | `ADMIN_TOKEN` | any long random string you make up — this is your admin password for uploading attachments |

3. **Deploy**
   - Deploy → New deployment → type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, authorize the permissions prompt (it's your own script, so
     this is expected), then copy the URL ending in `/exec`.

4. **Wire it into the app**
   - Open `app_main.py`, click **Configure...** next to "Drive bridge"
   - Paste the `/exec` URL and the `ADMIN_TOKEN` you made up
   - Click **Test connection** — should say "connected"
   - Click **Sync site assets** — this writes the URL into
     `assets/quiz.js`, `assign.js`, `attachments.js` on your live site

5. **Redeploy after editing Code.gs**
   Apps Script Web Apps don't auto-update on save — after changing
   `Code.gs`, go to Deploy → Manage deployments → edit (pencil) → New
   version → Deploy, or the live URL keeps serving the old code.

## Notes

- Student assignment submissions (`upload_submission`) don't require the
  admin token — anyone with the assignment page link can submit, same
  trust model as a normal Google Form.
- Attachment uploads and deletes (`upload_attachment`, `delete_attachment`)
  require the admin token, checked in `Code.gs`. Don't publish that token
  anywhere public — it only lives in your local `quiz_maker_config.json`
  and gets baked into nothing client-side.
- File requests (`?action=file&id=...`) run as **you** (Execute as: Me),
  so they work regardless of the file's own sharing settings — students
  never need "view access" to the file directly, only to your Web App URL.
- Google enforces Apps Script quotas (roughly: 50MB request size, daily
  URL-fetch/trigger limits well beyond what a class needs). `assign.js`
  caps client file uploads at 15MB to stay safely inside that.
