# Running and deploying

## Layout

```
src/            widget source (ES modules, bundled by tools/build.mjs into public/spengler-live.min.js)
public/         static site: index.html, fonts, _headers, embed example
worker/         Cloudflare Worker: serves /data/<match-id>.json from a private R2 bucket
tools/          build.mjs · prepare_data.py (CSVs -> match file) · upload.mjs · build_rink.py (hockey_rink -> src/rink.js)
```

## Data

Wisehockey data is licensed, so it is never committed (`data/`, `*.csv`, `*.xlsx` are git-ignored). A match file is built locally and uploaded to a private R2 bucket. The Worker serves it at `/data/<match-id>.json`, and only to pages on the site (or to origins listed in `ALLOWED_ORIGINS`). A browser still receives the data to draw it, so this stops hot-linking and casual downloads; it is not DRM.

Build a match file from the period CSVs. Keep Wisehockey's file names (`<Home>_<Away>_Game_Events_Periode <n>_<dd>_<mm>_<yyyy>.csv`): team names and the date come from them.

```bash
python3 tools/prepare_data.py <csv-folder> <match-id> --competition "Spengler Cup 2025 · Final" \
  --home-short "US Collegiate" --home-code USA --home-color "#d93a4e" --away-code HCD --away-color "#2f7ee6" --away-ink "#ffd84d"
```

This writes `<csv-folder>/<match-id>.json`. Upload it to the `spengler-live-data` bucket under the name `<match-id>.json`, either in the Cloudflare dashboard (R2 → bucket → Upload) or with `npm run upload -- <match-id>`.

## Deploy (Cloudflare Workers + R2)

1. The domain is on Cloudflare. Set the subdomain in `wrangler.jsonc` → `routes`. Cloudflare creates its DNS record and certificate on the first deploy, so don't add a record yourself.
2. Turn on R2 once (Storage & databases → R2; the free tier covers this). Create a bucket named `spengler-live-data` and upload the match file.
3. Workers & Pages → Create → Import a repository. Name the Worker `spengler-live`, set the build command to `npm run build`, and leave the deploy command as `npx wrangler deploy`. Every push to `main` redeploys.

From a terminal instead: `npm install`, `npx wrangler login`, `npx wrangler r2 bucket create spengler-live-data`, `npm run upload -- <match-id>`, `npm run deploy`. Local preview: `npm run upload -- <match-id> --local`, then `npm run dev`.

## Another match, or live

- **Archived match:** prepare and upload its file, then open `/?match=<match-id>`. Change `MATCH` in `public/index.html` to make it the default.
- **Live:** `/?feed-url=wss://…` (or an SSE URL). Each message is one Wisehockey event row, or an array of rows, with the CSV export's column names. From code, call `el.pushEvent(rows)`. Players, goalies, attacking direction (per period), score, strength, overtime and full time are all derived from the rows.
- **Wisehockey's live endpoint:** if it uses a different message shape or needs credentials, add a small adapter route in `worker/index.js`. Secrets belong in the Worker, never in the page.

Element attributes (also URL parameters on `/`):

| option | values |
|---|---|
| `src` / `match` | data URL / match id |
| `feed-url` | live WebSocket or SSE URL |
| `home-name` `home-short` `home-code` `home-color` `home-ink`, same for `away-…` | team name, phone-width name, scoreboard code, colour `#rrggbb`, jersey-number colour |
| `competition` | label next to "Live rink" |
| `ot-minutes` | overtime length (default 5) |
| `start` | `puck-drop` `first-goal` `p1-end` `p2` `p2-end` `p3` `final` or seconds |
| `speed` · `controls` · `theme="light"` · `autoscroll="false"` | replay speed · demo bar · white pages · no scroll at breaks |

JS: `el.pushEvent(rows)` and `el.setMeta({ home, away, competition })`. Events: `phasechange` (`live`, `intermission` or `final`) and `whatif-result`.

**Embedding.** Use an iframe of the site; the page posts its height (`spengler-live:height`) so the host can resize the frame, as in `public/embed-example.html`. Or use the web component directly; in that case add the host page's origin to `ALLOWED_ORIGINS`.

## Checks

- **Screen sizes:** tested in Chromium at 360×740, 390×844, 768×1024, 1024×768 (touch), 1366×768 and 1920×1080. No horizontal overflow; tap/click passing works; the layout swaps at breaks.
- **Browsers:** needs a 2022-or-newer browser (Safari 16.2+, Chrome/Edge 111+, Firefox 113+). Safari and Firefox still need checking on real devices.
- **Motion:** measured over a full period at 60 fps — the puck is within 1 m of a player at 97% of possession changes, and it never leaves the carrier's stick.
- **Archetypes:** match an independent recomputation exactly. Correlation with Wisehockey's official totals: PCW r = 0.72, PRE + BKS r = 0.78.
