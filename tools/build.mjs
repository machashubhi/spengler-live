// Bundle + minify the widget into public/spengler-live.min.js (one file, no runtime dependencies).
//   node tools/build.mjs               production bundle
//   node tools/build.mjs --standalone  also data/standalone.html (widget + match data inlined, for offline demos;
//                                      it contains Wisehockey data, so it lives in the git-ignored data/ folder)
import { build, transform } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const inline = {
  name: 'inline-text',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async ({ path }) => ({
      contents: (await transform(readFileSync(path, 'utf8'), { loader: 'css', minify: true })).code.trim(), loader: 'text',
    }));
    b.onLoad({ filter: /\.html$/ }, ({ path }) => ({ contents: readFileSync(path, 'utf8').replace(/>\s+</g, '><').trim(), loader: 'text' }));
  },
};
const out = 'public/spengler-live.min.js';
await build({ entryPoints: ['src/element.js'], outfile: out, bundle: true, minify: true, format: 'iife', target: 'es2020', legalComments: 'none', plugins: [inline],
  banner: { js: '/*! spengler-live · CC BY-NC 4.0 (https://creativecommons.org/licenses/by-nc/4.0/) · rink geometry: hockey_rink · data: Wisehockey */' } });
const js = readFileSync(out);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`${out}: ${kb(js.length)} · gzip ${kb(gzipSync(js).length)} · brotli ${kb(brotliCompressSync(js).length)}`);

if (process.argv.includes('--standalone')) {
  const id = process.argv[process.argv.indexOf('--standalone') + 1] || '2025-12-31-final';
  const data = readFileSync(`data/${id}.json`, 'utf8');
  const page = readFileSync('public/index.html', 'utf8')
    .replace(/<link rel="preload"[^>]*>\n?/g, '')
    .replace(/<script>\n  \/\/ Which match[\s\S]*?<\/script>\n/, '')
    .replace("    if (!q.has('feed-url')) m.setAttribute('src', '/data/' + MATCH + '.json');\n", '')
    .replace('url(/fonts/montserrat-latin-wght-normal.woff2)', `url(data:font/woff2;base64,${readFileSync('public/fonts/montserrat-latin-wght-normal.woff2').toString('base64')})`)
    .replace('<spengler-live-match id="match" controls>', '<spengler-live-match id="match" controls src="#match-data" start="first-goal">')
    .replace('<script src="/spengler-live.min.js" defer></script>',
      `<script type="application/json" id="match-data">${data}</script>\n<script>${String(js).replace(/<\/script/g, '<\\/script')}</script>`);
  writeFileSync('data/standalone.html', page);
  console.log(`data/standalone.html: ${kb(Buffer.byteLength(page))}`);
}
