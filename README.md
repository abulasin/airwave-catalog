# Airwave Atlas station catalog

The app's own copy of the station list: the Radio Browser directory, plus our additions,
minus removals, with corrections applied and streams checked. Built every night and published as
one file that the app downloads when it changes.

## The files you edit (`data/`)

| File | What goes in it |
| --- | --- |
| `additions.json` | Stations the directory lacks: name, stream `url`, two-letter `country`, and if known `state` (town or region), `tags`, `language`, `homepage`, `favicon`. A station only goes in if its stream answers on the night of the build. |
| `removals.json` | Stations to leave out: directory `ids`, exact `names`, or regular-expression `patterns`. For silent streams, duplicates, list titles that are not stations. |
| `corrections.json` | Stations filed under the wrong country or place, matched by name. Keep in step with `src/data/corrections.ts` in the app, which does the same for the live fallback. |
| `wanted.json` | Stations you want but have no stream address for: name, website, country. `find-streams.mjs` fills in the rest (below). |

Edit a file, commit, and the next build picks it up (a push to `main` also starts a build).

## What a build does (`build.mjs`)

1. Downloads the full directory export (about 50,000 stations) from a Radio Browser mirror.
2. Drops unusable entries and duplicates, applies `removals.json`, then `corrections.json`.
3. Adds the stations from `additions.json`.
4. Checks streams: all of ours, the 2,500 most played, and every station that failed last time.
   A directory station is dropped after three failed nights in a row; one of ours must answer
   tonight. The history lives in `checks.json` on the published site and is read back next run.
5. Writes `site/stations.json` (compact rows), `site/meta.json` (build time, count, checksum)
   and `site/checks.json`.

Run it yourself from this folder with Node 20 or newer:

```bash
node build.mjs             # full build, 10 to 20 minutes with the stream checks
node build.mjs --no-check  # a minute or two, no stream checks
```

## Publishing with GitHub (free, nothing to run)

1. Create a GitHub account if you have none, then a new **public** repository (Pages on a
   private repository needs a paid plan). Name it, say, `airwave-catalog`.
2. Put the contents of this `catalog/` folder in it and push to the `main` branch. The nightly
   job is the file `github-workflow-build.yml`: in the repository it must live at
   `.github/workflows/build.yml` (create the two folders and move it there; the dot at the start
   of `.github` matters).
3. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. **Actions** tab → **Build catalog** → **Run workflow**. The first run takes 10 to 20 minutes.
5. The catalog is then at `https://<your-user>.github.io/airwave-catalog/stations.json`.
   Put that address (without `stations.json`) in the app: `CATALOG_URL` in `src/catalog/config.ts`.

The job runs nightly at 04:17 UTC. The published files are uploaded as a Pages artifact, not
committed, so the repository never grows with them.

Limits that matter: GitHub Pages allows about 100 GB of downloads a month, and the file is about
5 MB compressed, so that is roughly 20,000 downloads a month. Each phone downloads at most once a
day, and only when the file changed.

## Finding a station's stream address automatically (`find-streams.mjs`)

Most stations publish only a web player, not the stream address behind it. This script opens the
site in a hidden browser, presses play, watches what the player loads, keeps the requests that
look like audio, tests them, and writes the working one into `additions.json`.

One-time setup, in this folder (downloads a browser, about 150 MB):

```bash
npm install
npx playwright install chromium
```

Then:

```bash
node find-streams.mjs --site https://example-radio.kz/   # one site: prints what it finds
node find-streams.mjs                                     # every entry in data/wanted.json → additions.json
node find-streams.mjs --dead                              # directory stations that failed the last check: look for a new address on their websites → data/repairs.json
```

It gets most sites, not all: players that need a real person's click, sites that block automated
browsers, and streams that are only served in some countries will come back as "nothing working
found". For those, Chrome's own Network panel (F12 → Network → filter `mp3` or `m3u8` → play) shows
the address, and it can be typed straight into `additions.json`.

`data/wanted.json` starts with six Kazakh stations whose sites I could not reach from where the
app was built; run the script once and commit what it finds.

## Adding stations from elsewhere

Any station with a working stream address can go in `additions.json`, whatever the source: a
broadcaster's own website, another open list, a friend's tip. Ask the app's author for an import
script if you have a whole list to bring in.
