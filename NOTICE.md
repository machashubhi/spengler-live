# Notices

This project is licensed under CC BY-NC 4.0 (see `LICENSE`), except for the parts below.

| Part | Licence | Notes |
|---|---|---|
| `tools/build_rink.py` | GPL-3.0-or-later | Imports [hockey_rink](https://github.com/the-bucketless/hockey_rink) (GPL-3.0). It is a build tool and is not shipped to browsers. |
| `src/rink.js` | CC BY-NC 4.0 | Rink geometry *output* by the script above (IIHF rink dimensions converted to SVG paths). It contains no hockey_rink code. |
| `public/fonts/montserrat-latin-wght-normal.woff2` | SIL Open Font License 1.1 | Montserrat © The Montserrat Project Authors; see `public/fonts/OFL.txt`. Packaged by Fontsource. |
| Match data | © Wisehockey / the event | Never committed. Kept in a private Cloudflare R2 bucket and served only to this site. |
| `esbuild`, `wrangler` (dev dependencies) | MIT / MIT-or-Apache-2.0 | Build and deploy tools only; not shipped. |

Spengler Cup is a name of HC Davos AG. This project is not affiliated with or endorsed by the tournament unless the organisers say so.
