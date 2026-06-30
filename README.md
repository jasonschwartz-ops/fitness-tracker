 Fitness Tracker — GitHub Pages Deployment

Single-file React app + PWA manifest + service worker. Hosts on GitHub
Pages for free, installs to your phone home screen, saves to localStorage,
and includes Export/Import for backups.

## Files

- `index.html` — the app (React via CDN, ~76 KB)
- `manifest.json` — PWA manifest
- `sw.js` — service worker for offline support
- `icon-192.png` and `icon-512.png` — home-screen icons
- `README.md` — this file

## Deploying from your phone

Same workflow as the foot tracker. Steps work entirely from a mobile
browser at github.com (use Safari or Chrome — the GitHub app hides
the Pages setting).

1. **Create the repo.** Go to **github.com/new**. Name it (e.g.
   `fitness-tracker`), set to **Public**, tap **Create repository**.

2. **Upload the files.** In the new repo, tap **Add file → Upload
   files**. Pick all 5 files from this package (`index.html`,
   `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`). Skip
   the README. Scroll down, tap **Commit changes**.

3. **Enable Pages.** Go to **Settings → Pages**. Under "Build and
   deployment," set Source to **Deploy from a branch**, Branch to
   **main**, folder **/ (root)**, then **Save**.

4. **Wait and grab the URL.** Refresh the Pages settings page after
   about a minute. URL will be:

       https://<your-username>.github.io/fitness-tracker/

5. **Install to home screen.** Open the URL on your phone. In Chrome:
   three-dot menu → **Install app** (or **Add to Home Screen**). In
   Safari: share button → **Add to Home Screen**.

## Notes

- Repo must be **Public** for free GitHub Pages. Private requires Pro.
- Data lives in that one browser. Tap **Export** in the app footer
  occasionally to grab a backup JSON. **Import** restores it on a new
  device or after clearing site data.
- Service worker caches the app shell after first load, so it works
  offline once installed.
- If you change `sw.js`, bump `CACHE_NAME` to bust caches.

## Migrating to Jamie later

When ready to fold this into your bot capabilities, use **Export** to
get a JSON dump and hand it to Jamie with the data schema. localStorage
keys map directly to SQLite tables: `workout:*`, `walk:*`, `weigh:*`,
`meal:*`, `recipe:*`, `route:*`.
