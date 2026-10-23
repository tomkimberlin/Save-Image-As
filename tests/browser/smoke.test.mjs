import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { startFixtures } from './fixtures.mjs';
import { launchFirefox } from './firefox-driver.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

for (const browserName of (process.env.TEST_BROWSER ? [process.env.TEST_BROWSER] : ['chromium', 'firefox'])) {
test(`${browserName} extension converts local fixtures through real browser APIs and downloads`, { timeout: 120_000 }, async (t) => {
  execFileSync(process.execPath, ['scripts/prepare-release.mjs'], { cwd: root });
  const fixtures = await startFixtures();
  const temporary = await mkdtemp(join(tmpdir(), 'save-image-as-browser-'));
  const downloadPath = join(temporary, 'downloads');
  await mkdir(downloadPath);
  const profile = join(temporary, 'profile');
  await mkdir(join(profile, 'Default'), { recursive: true });
  await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ download: {
    default_directory: downloadPath, prompt_for_download: false
  } }));
  const extension = resolve(root, `dist/${browserName}`);
  let context, firefoxDriver;
  try {
    let worker;
    if (browserName === 'firefox') {
      firefoxDriver = await launchFirefox(profile, downloadPath, extension);
      ({ context, worker } = firefoxDriver);
    } else {
    context = await chromium.launchPersistentContext(profile, {
      viewport: { width: 1100, height: 760 },
      channel: 'chromium', headless: process.env.HEADED !== '1', acceptDownloads: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    }
    const page = context.pages()[0] || await context.newPage();
    if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
    }
    await worker.evaluate(() => { globalThis.testExtensionApi = globalThis.browser ?? globalThis.chrome; });
    const inspector = await context.newPage();
    await worker.evaluate(() => testExtensionApi.storage.sync.set({ saveAsDialog: false }));
    await page.goto(fixtures.origin);
    const source = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 24;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#e32929'; ctx.fillRect(16, 0, 16, 24);
      const data = canvas.toDataURL('image/png');
      const blob = URL.createObjectURL(await (await fetch(data)).blob());
      const image = new Image(); image.id = 'blob-image'; image.src = blob; document.body.append(image);
      await image.decode();
      return { data, blob };
    });
    fixtures.setPng(Buffer.from(source.data.split(',')[1], 'base64'));
    const tabs = await worker.evaluate(() => testExtensionApi.tabs.query({}));
    const tabId = tabs.find((tab) => tab.url === `${fixtures.origin}/`).id;
    let sequence = 0;
    async function save(srcUrl, formatId, extra = {}) {
      sequence++;
      const before = await worker.evaluate(async () => (await testExtensionApi.downloads.search({})).map((item) => item.id));
      await worker.evaluate((request) => handleImageSave(request), {
        srcUrl, formatId, tab: { id: tabId }, pageUrl: `${fixtures.origin}/gallery`, frameId: 0, ...extra
      });
      const download = await worker.evaluate(async (before) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const item = (await testExtensionApi.downloads.search({})).find((item) => !before.includes(item.id));
          if (item?.state === 'interrupted') throw new Error(`Download interrupted: ${item.error}`);
          if (item?.state === 'complete') return item;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Download did not complete');
      }, before);
      assert.ok(download.filename.startsWith(`${downloadPath}/`), 'Downloads must remain in the fresh fixture directory');
      assert.ok(download.filename.endsWith(`.${formatId}`), `Expected ${formatId} filename, received ${download.filename}`);
      const bytes = await readFile(download.filename);
      if (formatId === 'png') assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      if (formatId === 'jpg') assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
      if (formatId === 'webp') { assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WEBP'); }
      const pixels = await inspector.evaluate(async ({ base64, mime }) => {
        const image = new Image(); image.src = `data:${mime};base64,${base64}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, corner: [...ctx.getImageData(0, 0, 1, 1).data] };
      }, { base64: bytes.toString('base64'), mime: formatId === 'jpg' ? 'image/jpeg' : `image/${formatId}` });
      return { ...pixels, byteLength: bytes.length };
    }
    for (const format of ['png', 'jpg', 'webp']) {
      await t.test(`${format}: signatures, dimensions, transparency and JPEG white matte`, async () => {
        const image = await save(`${fixtures.origin}/transparent.png`, format);
        assert.equal(image.width, 32); assert.equal(image.height, 24);
        if (format === 'jpg') assert.ok(image.corner.slice(0, 3).every((value) => value >= 245));
        else assert.equal(image.corner[3], 0);
      });
      await t.test(`${format}: cross-origin SVG`, async () => {
        const image = await save(`${fixtures.origin.replace('127.0.0.1', 'localhost')}/landscape.svg`, format);
        assert.equal(image.width, 640); assert.equal(image.height, 400);
      });
    }
    await t.test('embedded data and page-owned blob images', async () => {
      assert.equal((await save(source.data, 'png')).width, 32);
      assert.equal((await save(source.blob, 'webp')).width, 32);
      await page.evaluate((url) => URL.revokeObjectURL(url), source.blob);
      assert.equal((await save(source.blob, 'png')).width, 32, 'An already-visible revoked blob remains drawable');
    });
    await t.test('quality preferences affect actual JPG and WebP output sizes', async () => {
      for (const format of ['jpg', 'webp']) {
        await worker.evaluate(() => testExtensionApi.storage.sync.set({ jpegQuality: 0.1, webpQuality: 0.1 }));
        const low = await save(`${fixtures.origin}/landscape.svg`, format);
        await worker.evaluate(() => testExtensionApi.storage.sync.set({ jpegQuality: 1, webpQuality: 1 }));
        const high = await save(`${fixtures.origin}/landscape.svg`, format);
        assert.ok(low.byteLength < high.byteLength, `${format} should honor the quality setting`);
      }
    });
    await t.test('animation becomes one static image', async () => {
      const image = await save(`${fixtures.origin}/animation.gif`, 'png');
      assert.equal(image.width, 2); assert.equal(image.height, 1);
    });
    await t.test('corrupt, empty, denied and oversized images fail without downloads', async () => {
      for (const path of ['/corrupt', '/empty', '/denied', '/oversized']) {
        const before = await worker.evaluate(async () => (await testExtensionApi.downloads.search({})).length);
        await assert.rejects(save(`${fixtures.origin}${path}`, 'png'));
        assert.equal(await worker.evaluate(async () => (await testExtensionApi.downloads.search({})).length), before);
      }
    });
    await t.test(browserName === 'firefox' ? 'background conversion reads persisted settings' :
      'settings persist after a real options-page reload and reset', async () => {
      if (browserName === 'firefox') {
        await worker.evaluate(() => testExtensionApi.storage.sync.set({ jpegQuality: 0.55 }));
        assert.equal(await worker.evaluate(async () => (await getSettings()).jpegQuality), 0.55);
        return;
      }
      const extensionId = new URL(worker.url()).host;
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.locator('#settings-fields').waitFor({ state: 'visible' });
      await options.waitForFunction(() => !document.getElementById('settings-fields').disabled);
      await options.locator('#jpeg-quality').fill('0.55');
      await options.locator('button[type=submit]').click();
      await options.getByText('Settings saved.', { exact: true }).waitFor();
      await options.reload();
      await options.waitForFunction(() => !document.getElementById('settings-fields').disabled);
      assert.equal(await options.locator('#jpeg-quality').inputValue(), '0.55');
      await options.locator('#reset-button').click();
      await options.getByText('Settings reset to defaults.', { exact: true }).waitFor();
      assert.equal(await options.locator('#jpeg-quality').inputValue(), '0.92');
      if (process.env.CAPTURE_SCREENSHOT === '1') {
        await mkdir(resolve(root, 'docs'), { recursive: true });
        await options.setViewportSize({ width: 1100, height: 760 });
        await options.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await options.screenshot({ path: resolve(root, 'docs/extension-settings.png') });
      }
      await worker.evaluate(() => testExtensionApi.storage.sync.set({ saveAsDialog: false }));
      await options.close();
    });
    await t.test('strict page CSP can use its already-visible same-origin SVG', async () => {
      await page.goto(`${fixtures.origin}/csp`);
      assert.equal((await save(`${fixtures.origin}/landscape.svg`, 'png')).width, 640);
    });
    await t.test('blob images inside an iframe and open shadow root use the selected frame', async () => {
      await page.goto(`${fixtures.origin}/frame`);
      const frame = page.frames().find((item) => item.url().endsWith('/inner'));
      const blobUrl = await frame.evaluate(async () => {
        const blob = URL.createObjectURL(await (await fetch('/transparent.png')).blob());
        const host = document.createElement('div'); document.body.append(host);
        const image = new Image(); image.src = blob; host.attachShadow({ mode: 'open' }).append(image);
        await image.decode(); return blob;
      });
      const frames = await worker.evaluate((tabId) => testExtensionApi.scripting.executeScript({
        target: { tabId, allFrames: true }, func: () => location.href
      }), tabId);
      const frameId = frames.find((item) => item.result.endsWith('/inner')).frameId;
      assert.notEqual(frameId, 0);
      assert.equal((await save(blobUrl, 'png', { frameId })).width, 32);
    });
    await t.test('page fallback stops stalled image loading within its deadline', async () => {
      const start = Date.now();
      await assert.rejects(worker.evaluate(({ srcUrl, tabId }) => convertFromPageContext({
        srcUrl, tabId, frameId: 0, format: { label: 'PNG', mimeType: 'image/png' }
      }), { srcUrl: `${fixtures.origin}/stall`, tabId }), /Timed out/);
      assert.ok(Date.now() - start < 25_000);
    });
    t.diagnostic(`Browser ${context.browser().version()}; ${sequence} conversion attempts; isolated profile and downloads`);
  } finally {
    firefoxDriver?.close();
    await context?.close();
    await fixtures.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
}
