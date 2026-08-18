import { cp, mkdir, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const destination = new URL('../dist/firefox/', import.meta.url);
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

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const path of extensionFiles) {
  await cp(new URL(path, root), new URL(path, destination), { recursive: true });
}

await cp(new URL('manifest.firefox.json', root), new URL('manifest.json', destination));
console.log('Prepared Firefox extension in dist/firefox');
