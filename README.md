# Spengler Cup · Live Rink

A drop-in match page module with three parts:

1. **Live rink**: a 2D recreation of the game from Wisehockey tracking events. Under it: the score, clock and strength; xG for both teams; shots on goal; a period table; and key moments.
2. **Beyond the scoreboard**: three player-archetype cards (Zone Breaker, Puck Hound, The Wall). Each one teaches a stat that matters beyond goals, assists and shots, and shows tonight's leader on each team.
3. **What If?**: every goal becomes a mini-game. You start three passes before the real goal with the real positions, pass to beat the defence, and shoot to beat the real chance.

During play the rink sits on top, with the archetype cards under it. At each intermission and at full time the page fades, reorders itself, and brings the What-If game to the top with a countdown to the next period. When play restarts, the rink returns to the top.

## Repository layout

```
src/                 widget source (ES modules, bundled into one file)
  element.js         <spengler-live-match>: data flow, layout, scoreboard, team settings
  motion.js          smoothing engine (see "Smooth motion")
  state.js           score, clock, phases, archetype numbers
  archetypes.js      the three cards
  whatif.js          the What-If game
  scenario.js        builds a What-If start from the event stream
  rink-view.js       SVG rink, tokens, puck, effects
  model.js           players, event decoding, per-period orientation
  feeds.js           replay clock / live WebSocket or SSE
  rink.js            rink geometry generated from hockey_rink
  styles.css, template.html
public/              deployed as static files (index.html, fonts, _headers, embed example)
worker/index.js      Cloudflare Worker: serves match data from a private R2 bucket
tools/
  build.mjs          bundle + minify -> public/spengler-live.min.js
  prepare_data.py    Wisehockey CSVs -> data/<match-id>.json (any match)
  upload.mjs         data/<match-id>.json -> private R2 bucket
  build_rink.py      hockey_rink -> src/rink.js (GPL-3.0, see NOTICE.md)
data/                local only, git-ignored: raw CSVs and generated match files
```

## Wisehockey data stays out of GitHub

`data/`, `*.csv` and `*.xlsx` are git-ignored. Match files are built locally and uploaded to a **private R2 bucket**. The Worker hands them out at `/data/<match-id>.json`, and only to pages on your subdomain (or to origins you list in `ALLOWED_ORIGINS`). Typing the URL directly, or loading it from another site, gets a 403. A browser still has to receive the data to draw it, so treat this as protection against hot-linking and casual downloads, not DRM.

## Deploy on Cloudflare (your subdomain)

Prerequisites: the domain's zone is on Cloudflare, Node 20+, and Python 3 with pandas and numpy (data prep only).

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create spengler-live-data   # private bucket for match data (once)
npm run data:demo                                 # this final -> data/2025-12-31-final.json
npm run upload -- 2025-12-31-final                # -> R2
# set your subdomain in wrangler.jsonc ("routes"), then:
npm run deploy
```

**Deploy from GitHub.** In Cloudflare go to Workers & Pages → Create → Import a repository. Set the build command to `npm run build`; the deploy command `npx wrangler deploy` is the default. Data uploads stay a manual, local step, so data never passes through GitHub.

**Local development:** `npm run upload -- 2025-12-31-final --local`, then `npm run dev`, then http://localhost:8787.

## Another match

Nothing in the code is specific to this final. Team names, players, jersey numbers, goalies, attacking directions, colours and the competition label all come from the data or from settings.

**From Wisehockey export files (replay / after the game).** Put the period CSVs in a folder, keeping Wisehockey's file names (`<Home>_<Away>_Game_Events_Periode <n>_<dd>_<mm>_<yyyy>.csv`). Team names and the date are read from those names.

```bash
npm run data -- data/my-match 2026-12-29-quarterfinal --competition "Spengler Cup 2026 · Quarter-final" \
  --home-code SCL --home-color "#f2a900" --away-code FRO --away-color "#00704a"
npm run upload -- 2026-12-29-quarterfinal
```

Open `https://spengler.shubhamruhe.la/?match=2026-12-29-quarterfinal`. To make it the page's default, change `MATCH` in `public/index.html`.

**Live.** Point the widget at a feed that sends Wisehockey event rows (the same columns as the CSV export), one row or an array per message, over WebSocket or Server-Sent Events:

```
https://spengler.shubhamruhe.la/?feed-url=wss://feed.example.com/match/123&home-name=SCL%20Tigers&home-code=SCL&home-color=%23f2a900&away-name=Fr%C3%B6lunda%20HC&away-code=FRO
```

Or push rows from your own code with `el.pushEvent(rows)`, and set teams with `el.setMeta({ home: {name, code, color}, away: {...}, competition })`.

What adapts automatically:
- **Players** (names, numbers, teams) are registered from each row's `StartPlayerName/Team` fields.
- **Goalies** are detected as the player living near a goal line.
- **Attacking direction** is worked out per period from the home goalie's position. Feeds where teams change ends each period are turned around, so home always attacks right.
- **Scoreboard and moments:** score, xG, shots, strength, power plays, empty nets, penalties, period ends, overtime and full time all come from the events.
- **What-If** scenarios are built the moment each goal arrives; the archetype cards update as play goes on.

Settings (attributes on the element, or URL parameters on `/`):

| option | values |
|---|---|
| `match` (URL) / `src` (attribute) | match id / data URL |
| `feed-url` | `wss://…` or SSE `https://…` live feed |
| `home-name` `home-short` `home-code` `home-color` `home-ink` (same for `away-…`) | team name, phone-width name, 3–4 letter code, colour `#rrggbb`, jersey-number colour (defaults to white or navy for contrast) |
| `competition` | label next to "Live rink" |
| `ot-minutes` | overtime length for the clock (default 5) |
| `start` | `puck-drop` `first-goal` `p1-end` `p2` `p2-end` `p3` `final` or seconds (also as `#p1-end`) |
| `speed`, `controls`, `theme=light`, `autoscroll=false` | replay speed, demo bar, white pages, no scroll at intermissions |

The JS API fires `phasechange` (`live`, `intermission` or `final`) and `whatif-result` events.

Two things to arrange per deployment: Wisehockey's **live endpoint** (its URL, auth and message format — a small adapter is needed if it isn't rows in the export format, and secrets belong in the Worker, not the page) and the **arena**. The rink is IIHF size (60 × 30 m), which is what Davos uses.

**Tested this way:** the final was disguised as a different match — home and away swapped, teams changing ends every period, every player renamed, renumbered and re-identified, new team names, colours and date. Through both the file path and the live `pushEvent` path, the widget produced the exact mirror of the real game (6–3, all 9 goals, xG and every archetype total swapped), with the home goalie defending the left end in every period.

## Devices

Tested in Chromium at 360×740 and 390×844 (phones, touch), 768×1024 and 1024×768 (tablets, touch), 1366×768 and 1920×1080 (desktop, mouse). On every size:
- the page doesn't scroll sideways and nothing overflows;
- tap or click passing works;
- What-If moves to the top at breaks.

Phones get short team names and swipeable archetype cards; rink tokens are at least 20 px. Needs a browser from 2022 or later (Safari/iOS 16.2+, Chrome/Edge 111+, Firefox 113+) because of container queries and `color-mix`. Safari and Firefox engines have not been run yet; check them on real devices after deploying.

## Smooth motion

Wisehockey sends a position snapshot of every player at each event, about one per second and irregular, and the tracked puck sits a median **1.6 m** from its carrier. `motion.js` works like frame generation in games:

- **Players** follow cubic Hermite curves through the snapshots. Where Wisehockey measured a velocity (passes, shots, dumps, blue-line crossings) it's used as the curve's tangent; elsewhere the tangent is estimated from the neighbouring snapshots. Speeds are capped at 11 m/s. Past the newest snapshot a player glides on and eases to a stop.
- **Puck:** the PuckControl chain gives a continuous path. A controlled puck rides on the carrier's stick, and a loose puck glides between keyframes.
- **Contact:** at every puck keyframe, whoever touches it (the credited carrier, the inferred one when the feed names nobody, or the passer releasing it) is pulled within a stick's length. The correction is eased over ±0.5 s.
- **Playout buffer:** the drawing runs 2.5 s behind the newest data, and the scoreboard and effects fire on the same delayed clock.

Over the whole first period at 60 fps: the puck is within 1 m of a player at **97%** of control changes (22% with raw snapshots); the carrier never loses the puck off his stick; and large acceleration jumps fall by **41%** versus straight-line interpolation. The What-If "watch the real goal" replay uses the same engine.

## Beyond the scoreboard

The scoreboard already carries goals, shots on goal and expected goals (xG, shot quality). The cards cover the next layer: how teams win the puck, move it up the ice and stop the other side.

| Card | Stat (live, from events) | Why it matters | Rule |
|---|---|---|---|
| Zone Breaker | controlled zone entries | carrying the puck in, rather than dumping it, keeps possession; studies of zone entries find carry-ins lead to far more shots | BluelineCrossing towards the opponent at their line, PossessionMaintained |
| Puck Hound | puck battles won | possession is won along the boards | contested puck (PuckControlContestingPlayerIds) next controlled by him |
| The Wall | pressures + blocks | defending that never reaches the scoresheet | within 3 m of an opposing passer/shooter at the moment of the pass/shot, plus blocked shots (nearest skater to the lane) |

The card numbers match an independent Python computation exactly. They also track Wisehockey's official totals: puck battles r = 0.72 with PCW, and pressure plus blocks r = 0.78 with PRE + BKS. Other candidates (Jet, Net-Front, Pest, Magnet) need roster positions or several games to be reliable.

## Licence

Code, styles and docs: **CC BY-NC 4.0** (see `LICENSE`). Non-commercial use only; commercial use needs written permission. Third-party parts are listed in `NOTICE.md`.
