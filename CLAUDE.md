# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static site (French) for a motorcycle trip: an interactive map plus a day-by-day
itinerary for a 15-day, 4-country Andes raid. No build step, no bundler, no
frontend framework — plain ES modules loaded directly by the browser. A small
Cloudflare Worker (`worker/`) backs an optional "carnet de route" feature (participants
post notes/photos/videos); the site itself works without it.

Read [README.md](README.md) first — it documents the data model (`data/etapes.json`),
the four color "habillages", the carnet feature's offline-queue UX, and the
full worker deployment sequence in more depth than is repeated here.

## Commands

Serve the site (required — opening `index.html` directly fails, the browser
blocks the `fetch` of local data files over `file://`):

```bash
python3 -m http.server 8123
```

It must be **exactly port 8123** in local dev: the worker's CORS allowlist
(`ORIGINES_AUTORISEES` in `worker/wrangler.toml`) only permits that origin.

Run the worker locally (separate terminal, separate port):

```bash
cd worker
npm install
npx wrangler d1 execute souvenirs --local --file=schema.sql
npx wrangler dev --local --port 8787
```

Worker tests (24 tests, plain `node:test`, no other test runner in the repo):

```bash
cd worker && node --test test/
# single file:
cd worker && node --test test/securite.test.js
```

Deploy the worker after editing `worker/index.js` or `worker/lib/`:

```bash
cd worker && npx wrangler deploy
```
If `schema.sql` changed, apply it to the remote D1 database *before* deploying
(`npx wrangler d1 execute souvenirs --remote --file=schema.sql`) — it's
idempotent (`IF NOT EXISTS`, `INSERT OR IGNORE`), safe to rerun.

The site itself has no deploy command to run by hand: pushing to `main`
triggers `.github/workflows/pages.yml` (GitHub Pages, no compile step).

Rebuilding `data/parcours.geojson` (only if a route source changes):

```bash
python3 -m pip install pypdf pillow
python3 tools/construire_parcours.py
```
It prints, per stage, the gap between the computed distance and the brochure's
— that gap is the guard rail against a wrong coordinate; keep it near the
current ~1%.

## Architecture

**Frontend (`js/`)**, all ES modules, no CDN, no API keys — Leaflet is vendored
under `js/vendor/` and `css/vendor/`:

- `app.js` — orchestrator. Owns the single `etat` state object, loads
  `data/etapes.json` + `data/parcours.geojson`, mounts the map/frise/panel, and
  keeps them in sync. The current day lives in the URL hash (`#j7`), not just
  in memory — every day is directly linkable.
- `carte.js` — the Leaflet map: basemaps, route traces, waypoints, and the
  cursor synced to profile-chart hover.
- `profil.js` — all SVG rendering, hand-written (no charting library): both the
  top "frise" (the whole-trip altitude profile, which doubles as the site's main
  day-navigation bar — there is no separate day list; a permanent
  previous/next bar at the foot of the scene is the only other way through the
  days) and each stage's small altitude chart.
- `souvenirs.js` / `souvenirs-file.js` / `souvenirs-vue.js` — the
  participant-memories feature, deliberately split by concern and not to be
  merged: `souvenirs.js` talks to the Worker and never touches the DOM;
  `souvenirs-file.js` is an IndexedDB-backed retry queue for posts that fail
  (built for the Andes' unreliable network — nothing is lost, it retries on
  its own); `souvenirs-vue.js` owns the DOM for the "Carnet de route" tab and is the
  only one of the three allowed to read/write `localStorage`.
- `admin.js` — separate moderation page (`admin.html`, `noindex`), gated by its
  own session-only password, can list/delete any contribution across all days.

**Vocabulary**: on screen the feature is the *carnet de route*, and one entry
is a *note* — the trip is read as it happens, "souvenir" placed it in a distant
past. The code kept the old name everywhere (`souvenirs*.js`, the D1 database,
the API routes): renaming the plumbing would have meant a migration for a
change that only concerns the copy. Expect the two vocabularies side by side.

**Data**: `data/etapes.json` is the trip's entire editorial content (day
narratives, photo lists, waypoints) — edit this for content changes, never
hardcode trip text in JS. `data/parcours.geojson` holds the route traces and
altitude samples (2 km resolution), produced by `tools/construire_parcours.py`.
`data/config.json` holds one field, the Worker's URL — the single file changed
when switching the deployed site between local and production worker.

**Worker (`worker/`)**: one file, `index.js` (no router library), fronting D1
(`schema.sql`) for notes and R2 for media. Auth is two shared secrets (a group
password and a separate, longer admin password) via `wrangler secret`, not a
user-account system. `worker/lib/securite.js` is kept pure and dependency-free
on purpose so it can run under both the Workers runtime and plain `node --test`.

**Theming**: four color "habillages" chosen via a `data-habillage` attribute on
`<html>` (`js/app.js`, persisted to `localStorage`) are pure CSS custom-property
swaps in `css/style.css` — no layout rule is allowed to differ between them.
This is enforced by discipline, not tooling: never hardcode a color that isn't
a `var(--...)`, or a habillage will silently regress elsewhere.

## Conventions

- Everything is in French: code comments, commit messages, UI copy. Comments
  lean long and explain *why* a decision was made (including which alternative
  was rejected and why), not just what the code does — match that density and
  tone rather than writing terser English-style comments.
- No linter or formatter is configured; match the surrounding code by eye.
- Commits are small and atomic, one behavioral change each, titled like
  `Frise : les deux bords se répondent` (area, colon, what changed) — check
  `git log` for the pattern before writing a commit message.
