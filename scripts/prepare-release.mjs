import { cp, mkdir, readFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const extensionFiles = [
  'icons',
  'options.css',
  'options.html',
  'options.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'service-worker.js'
];

await rm(dist, { recursive: true, force: true });

for (const browser of ['chromium', 'firefox']) {
  const destination = new URL(`${browser}/`, dist);
  await mkdir(destination, { recursive: true });

  for (const path of extensionFiles) {
    await cp(new URL(path, root), new URL(path, destination), { recursive: true });
  }
}

await cp(new URL('manifest.json', root), new URL('chromium/manifest.json', dist));
await cp(new URL('manifest.firefox.json', root), new URL('firefox/manifest.json', dist));

const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
console.log(`Prepared Save Image As ${manifest.version} for Chromium and Firefox in dist/`);
