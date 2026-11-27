// Builds a static, serverless demo (you vs bots, all in the browser) into demo/dist.
// Host the folder anywhere static, e.g. GitHub Pages. Its index.html is a page
// fragment (no <html>/<head>) so it can also be published as a claude.ai Artifact;
// browsers render it fine either way.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
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
  'local-backend.js': 'demo/local-backend.js',
};
for (const [to, from] of Object.entries(copies)) copyFileSync(join(root, from), join(out, to));

const css = readFileSync(join(root, 'public/styles.css'), 'utf8');
writeFileSync(join(out, 'index.html'), `<title>Cribbage Table</title>
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
  await import('./app.js');
</script>
`);
console.log(`Demo built in ${out}`);
