// Builds a static, serverless demo (you vs bots, all in the browser) into demo/dist.
// Host the folder anywhere static, e.g. GitHub Pages. Its index.html is a page
// fragment (no <html>/<head>) so it can also be published as a claude.ai Artifact;
// browsers render it fine either way.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'demo', 'dist');
mkdirSync(out, { recursive: true });

const copies = {
  'app.js': 'public/app.js',
  'ui.js': 'public/ui.js',
  'push-client.js': 'public/push-client.js',
  'sound.js': 'public/sound.js',
  'engine.js': 'src/engine.js',
  'bot.js': 'src/bot.js',
  'stats.js': 'src/stats.js',
  'games.js': 'src/games.js',
  'holdem.js': 'src/holdem.js',
  'holdem-bot.js': 'src/holdem-bot.js',
  'poker-hands.js': 'src/poker-hands.js',
  'holdem-ui.js': 'public/holdem-ui.js',
  'thirtyone.js': 'src/thirtyone.js',
  'thirtyone-bot.js': 'src/thirtyone-bot.js',
  'thirtyone-ui.js': 'public/thirtyone-ui.js',
  'local-backend.js': 'demo/local-backend.js',
};
for (const [to, from] of Object.entries(copies)) copyFileSync(join(root, from), join(out, to));

// Background music: copy public/music/* and list the tracks for the page.
const musicDir = join(root, 'public/music');
const songs = existsSync(musicDir) ? readdirSync(musicDir).filter((f) => /\.(mp3|m4a|ogg)$/i.test(f)).sort() : [];
if (songs.length) mkdirSync(join(out, 'music'), { recursive: true });
for (const f of songs) copyFileSync(join(musicDir, f), join(out, 'music', f));
const title = (f) => { const t = f.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const music = songs.map((f) => ({ url: `music/${encodeURIComponent(f)}`, title: title(f) }));

const css = readFileSync(join(root, 'public/styles.css'), 'utf8');
writeFileSync(join(out, 'index.html'), `<title>Card Night</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta charset="utf-8">
<meta name="theme-color" content="#07110d">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700;800&display=swap">
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
  import { transport } from './local-backend.js';
  window.CRIB_TRANSPORT = transport;
  window.CRIB_MUSIC = ${JSON.stringify(music)};
  await import('./app.js');
</script>
`);
console.log(`Demo built in ${out}${songs.length ? ` with ${songs.length} song(s)` : ''}`);
