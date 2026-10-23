import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
test('browser packages contain matching versions, supported backgrounds and only runtime files', async () => {
  execFileSync(process.execPath, ['scripts/prepare-release.mjs'], { cwd: root });
  const chromium = JSON.parse(await readFile(new URL('dist/chromium/manifest.json', root)));
  const firefox = JSON.parse(await readFile(new URL('dist/firefox/manifest.json', root)));
  assert.equal(chromium.version, firefox.version);
  assert.deepEqual(chromium.permissions, ['contextMenus', 'downloads', 'storage', 'scripting']);
  assert.deepEqual(chromium.host_permissions, firefox.host_permissions);
  assert.deepEqual(chromium.permissions, firefox.permissions);
  assert.equal(chromium.background.service_worker, 'service-worker.js');
  assert.deepEqual(firefox.background.scripts, ['service-worker.js']);
  assert.equal(firefox.background.service_worker, undefined);
  const runtimeFiles = ['icons', 'manifest.json', 'options.css', 'options.html', 'options.js',
    'popup.css', 'popup.html', 'popup.js', 'service-worker.js'];
  for (const browser of ['chromium', 'firefox']) {
    const directory = new URL(`dist/${browser}/`, root);
    assert.deepEqual((await readdir(directory)).sort(), runtimeFiles.sort());
    for (const icon of Object.values(chromium.icons)) await access(new URL(icon, directory));
  }
});
