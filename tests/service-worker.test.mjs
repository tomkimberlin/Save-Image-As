import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');

function loadWorker() {
  const downloads = [];
  const injections = [];
  const revoked = [];
  const events = {};
  const event = (name) => ({ addListener: (listener) => { events[name] = listener; } });
  class TestURL extends URL {
    static createObjectURL() { return 'blob:converted'; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const api = {
    runtime: { onInstalled: event('installed'), onStartup: event('startup') },
    contextMenus: { onClicked: event('clicked') },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
    downloads: {
      onChanged: event('downloadChanged'),
      onErased: event('downloadErased'),
      download: async (options) => { downloads.push(options); return 1; },
      search: async () => [{ id: 1, state: 'in_progress' }]
    },
    storage: { sync: { get: async (defaults) => ({ ...defaults }) } },
    scripting: {
      executeScript: async (injection) => {
        injections.push(injection);
        return [{ result: { ok: true, dataUrl: 'data:image/png;base64,AA==' } }];
      }
    }
  };
  const context = vm.createContext({
    browser: api, URL: TestURL, Blob, TextEncoder, AbortSignal,
    console: { warn() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url) => url.startsWith('data:')
      ? fetch(url)
      : { ok: true, blob: async () => new Blob(['source'], { type: 'image/png' }) },
    createImageBitmap: async () => ({ width: 2, height: 2, close() {} }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {}, fillRect() {} }; }
      async convertToBlob({ type }) { return new Blob(['converted'], { type }); }
    }
  });
  vm.runInContext(source, context);
  return { context, api, downloads, injections, revoked, events };
}

const request = {
  formatId: 'png', srcUrl: 'https://images.example/photo.webp',
  pageUrl: 'https://example.com/gallery', frameId: 3, tab: { id: 7 }
};

test('conversion downloads once, with the selected format and Save As preference', async () => {
  const { context, api, downloads, injections } = loadWorker();
  api.storage.sync.get = async () => ({ jpegQuality: 0.75, webpQuality: 0.8, saveAsDialog: false });
  let encoding;
  context.OffscreenCanvas.prototype.convertToBlob = async (options) => {
    encoding = options;
    return new Blob(['jpg'], { type: options.type });
  };
  await context.handleImageSave({ ...request, formatId: 'jpg' });
  assert.equal(encoding.type, 'image/jpeg');
  assert.equal(encoding.quality, 0.75);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'photo.jpg');
  assert.equal(downloads[0].saveAs, false);
  assert.equal(downloads[0].conflictAction, 'uniquify');
  assert.equal(injections.length, 0);
});

for (const message of ['Download canceled', 'Download canceled by the user', 'USER_CANCELED']) {
  test(`canceling Save As stops quietly: ${message}`, async () => {
    const { context, api, injections, revoked } = loadWorker();
    let attempts = 0;
    api.downloads.download = async () => { attempts++; throw new Error(message); };
    await context.handleImageSave(request);
    assert.equal(attempts, 1);
    assert.equal(injections.length, 0);
    assert.deepEqual(revoked, ['blob:converted']);
  });
}

test('a disk error is reported without retrying conversion or opening another dialog', async () => {
  const { context, api, injections, revoked } = loadWorker();
  api.downloads.download = async () => { throw new Error('FILE_ACCESS_DENIED'); };
  await assert.rejects(context.handleImageSave(request), /FILE_ACCESS_DENIED/);
  assert.equal(injections.length, 0);
  assert.deepEqual(revoked, ['blob:converted']);
});

test('embedded data images convert without needing an image element or tab', async () => {
  const { context, injections, downloads } = loadWorker();
  await context.handleImageSave({ ...request, srcUrl: 'data:image/png;base64,AA==', tab: undefined });
  assert.equal(injections.length, 0);
  assert.equal(downloads.length, 1);
});

test('a fetch failure falls back in the selected frame', async () => {
  const { context, injections, downloads } = loadWorker();
  context.fetch = async (url) => {
    if (url.startsWith('data:')) return fetch(url);
    throw new Error('HTTP 403');
  };
  await context.handleImageSave(request);
  assert.equal(injections.length, 1);
  assert.equal(injections[0].target.tabId, 7);
  assert.deepEqual([...injections[0].target.frameIds], [3]);
  assert.equal(injections[0].args[0].sourceDataUrl, null);
  assert.equal(downloads[0].url, 'blob:converted');
});

test('undecodable blobs reuse fetched bytes in the page (including cross-origin SVG)', async () => {
  const { context, injections } = loadWorker();
  context.createImageBitmap = async () => { throw new Error('SVG not supported'); };
  context.blobToDataUrl = async () => 'data:image/svg+xml;base64,PHN2Zy8+';
  await context.handleImageSave(request);
  assert.equal(injections[0].args[0].sourceDataUrl, 'data:image/svg+xml;base64,PHN2Zy8+');
});

test('blob images go directly to their owning frame without a background fetch', async () => {
  const { context, injections } = loadWorker();
  context.fetch = (url) => {
    assert.ok(url.startsWith('data:'), 'Only converted data should be fetched by the background');
    return fetch(url);
  };
  await context.handleImageSave({ ...request, srcUrl: 'blob:https://example.com/id' });
  assert.equal(injections.length, 1);
});

test('Firefox page conversions use extension object URLs instead of rejected data URLs', async () => {
  const { context, downloads } = loadWorker();
  await context.handleImageSave({ ...request, srcUrl: 'blob:https://example.com/id' });
  assert.equal(downloads[0].url, 'blob:converted');
});

test('Chromium page conversions keep data URLs when worker object URLs are unavailable', async () => {
  const { context, downloads } = loadWorker();
  context.URL.createObjectURL = undefined;
  context.URL.revokeObjectURL = undefined;
  await context.handleImageSave({ ...request, srcUrl: 'blob:https://example.com/id' });
  assert.equal(downloads[0].url, 'data:image/png;base64,AA==');
});

test('page fallback rejects unexpected MIME types instead of mislabeling a file', async () => {
  const { context, api, downloads } = loadWorker();
  api.scripting.executeScript = async () => [{ result: { ok: true, dataUrl: 'data:image/png-bogus;base64,AA==' } }];
  await assert.rejects(context.handleImageSave({ ...request, srcUrl: 'blob:https://example.com/id' }), /image data/);
  assert.equal(downloads.length, 0);
});

function mockPage(worker, images) {
  const drawn = [];
  worker.context.document = {
    querySelectorAll: (selector) => selector === 'img' ? images : [],
    createElement: () => ({
      getContext: () => ({ drawImage: (image) => drawn.push({ ...image }), fillRect() {} }),
      toBlob: (callback, type) => callback(new Blob(['pixels'], { type }))
    })
  };
  worker.context.Image = class {
    naturalWidth = 64;
    naturalHeight = 48;
    async decode() {
      if (this.src.startsWith('data:text/html')) throw new Error('Not an image');
    }
  };
  worker.context.FileReader = class {
    readAsDataURL(blob) {
      this.result = `data:${blob.type};base64,AA==`;
      this.onload();
    }
  };
  worker.api.scripting.executeScript = async ({ func, args }) => [{ result: await func(...args) }];
  return drawn;
}

const pageRequest = {
  format: { label: 'PNG', mimeType: 'image/png' },
  srcUrl: 'blob:https://example.com/selected', tabId: 7, frameId: 3
};

test('page conversion uses the selected currentSrc when responsive images share a src', async () => {
  const worker = loadWorker();
  const selected = { src: pageRequest.srcUrl, currentSrc: pageRequest.srcUrl, naturalWidth: 64, naturalHeight: 48 };
  const other = { ...selected, currentSrc: 'blob:https://example.com/other' };
  const drawn = mockPage(worker, [other, selected]);
  await worker.context.convertFromPageContext(pageRequest);
  assert.equal(drawn[0].currentSrc, selected.currentSrc);
});

test('page conversion can load a blob even when no matching img exists', async () => {
  const worker = loadWorker();
  const drawn = mockPage(worker, []);
  await worker.context.convertFromPageContext(pageRequest);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].src, pageRequest.srcUrl);
});

test('a login response on refetch still allows exporting the visible image', async () => {
  const worker = loadWorker();
  const visible = { src: pageRequest.srcUrl, naturalWidth: 64, naturalHeight: 48 };
  const drawn = mockPage(worker, [visible]);
  await worker.context.convertFromPageContext({ ...pageRequest, sourceDataUrl: 'data:text/html,<h1>Log in</h1>' });
  assert.equal(drawn[0].src, visible.src);
});

test('canvas encoding rejects empty output and silent PNG fallback', async () => {
  const { context } = loadWorker();
  const webp = { label: 'WebP', mimeType: 'image/webp' };
  assert.throws(() => context.validateConvertedBlob(new Blob([]), webp), /encode WebP/);
  assert.throws(() => context.validateConvertedBlob(new Blob(['png'], { type: 'image/png' }), webp), /encode WebP/);
  assert.throws(() => context.validateConvertedBlob(null, webp), /encode WebP/);
});

test('image bitmaps are released even when encoding fails', async () => {
  const { context } = loadWorker();
  let closed = false;
  context.createImageBitmap = async () => ({ width: 1, height: 1, close() { closed = true; } });
  context.OffscreenCanvas.prototype.convertToBlob = async () => { throw new Error('out of memory'); };
  await assert.rejects(context.convertBlob(new Blob(['x']), { mimeType: 'image/png' }), /out of memory/);
  assert.equal(closed, true);
});

test('network requests have a timeout and retain credentials for authenticated images', async () => {
  const { context } = loadWorker();
  context.fetch = async (url, options) => {
    assert.equal(options.credentials, 'include');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: false, status: 403 };
  };
  await assert.rejects(context.fetchImageBlob(request.srcUrl), /403/);
});

for (const state of ['complete', 'interrupted']) {
  test(`object URLs are freed when downloads become ${state}`, async () => {
    const { context, events, revoked } = loadWorker();
    await context.startDownload('blob:converted', 'image.png', false);
    assert.deepEqual(revoked, []);
    events.downloadChanged({ id: 1, state: { current: state } });
    events.downloadChanged({ id: 1, state: { current: state } });
    assert.deepEqual(revoked, ['blob:converted']);
  });
}

test('object URLs are also freed when completion arrives before the download ID', async () => {
  const { context, api, events, revoked } = loadWorker();
  api.downloads.download = async () => {
    events.downloadChanged({ id: 1, state: { current: 'complete' } });
    return 1;
  };
  api.downloads.search = async () => [{ id: 1, state: 'complete' }];
  await context.startDownload('blob:converted', 'image.png', false);
  assert.deepEqual(revoked, ['blob:converted']);
});

test('Unicode filenames fit common filesystem limits without splitting characters', () => {
  const { context } = loadWorker();
  for (const name of ['猫'.repeat(100), '📸'.repeat(100), 'a'.repeat(300)]) {
    const result = context.sanitizeFilename(name);
    assert.ok(Buffer.byteLength(result) <= 180);
    assert.ok(result.isWellFormed());
    assert.ok(name.startsWith(result));
  }
});

test('filenames avoid hidden files, reserved Windows names, path separators and bidi controls', () => {
  const { context } = loadWorker();
  const cases = [
    ['.photo', 'photo'], ['CON', '_CON'], ['LPT1.preview', '_LPT1.preview'],
    ['a/b\\c:d?e', 'a-b-c-d-e'], ['photo\u202egpj', 'photo-gpj'], ['... ', '']
  ];
  for (const [input, expected] of cases) assert.equal(context.sanitizeFilename(input), expected);
});

test('filenames retain usable URL paths even with malformed percent encoding', () => {
  const { context } = loadWorker();
  assert.equal(context.buildFilenameBase('https://example.com/100%real.png?width=100', ''), '100%real');
  assert.equal(context.buildFilenameBase('https://example.com/caf%C3%A9.webp', ''), 'café');
  assert.equal(context.buildFilenameBase('blob:https://example.com/id', 'https://example.com/gallery.html'), 'gallery');
});

for (const formatId of ['png', 'jpg', 'webp']) {
  test(`public AMO images retry anonymously and save ${formatId} without page access`, async () => {
    const { context, api, downloads, injections } = loadWorker();
    const calls = [];
    const srcUrl = 'https://addons.mozilla.org/static-server/img/addon-icons/default-64.png';
    context.fetch = async (url, options) => {
      assert.equal(url, srcUrl);
      calls.push(options);
      if (options.credentials === 'include') throw new TypeError('NetworkError');
      return { ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) };
    };
    api.scripting.executeScript = async () => { throw new Error('Missing host permission for the tab'); };
    await context.handleImageSave({ ...request, formatId, srcUrl, pageUrl: 'https://addons.mozilla.org/' });
    assert.deepEqual(calls.map((call) => call.credentials), ['include', 'omit']);
    assert.equal(calls[0].signal, calls[1].signal, 'Retries share the original time budget');
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].filename, `default-64.${formatId}`);
    assert.equal(injections.length, 0);
  });
}

test('HTTP errors do not retry without credentials', async () => {
  const { context } = loadWorker();
  let attempts = 0;
  context.fetch = async () => { attempts++; return { ok: false, status: 403 }; };
  await assert.rejects(context.fetchImageBlob(request.srcUrl), /403/);
  assert.equal(attempts, 1);
});

test('an expired network timeout does not start an anonymous retry', async () => {
  const { context } = loadWorker();
  const controller = new AbortController();
  context.AbortSignal = { timeout: () => controller.signal };
  let attempts = 0;
  context.fetch = async () => {
    attempts++;
    controller.abort();
    throw new Error('timeout');
  };
  await assert.rejects(context.fetchImageBlob(request.srcUrl), /timeout/);
  assert.equal(attempts, 1);
});

test('non-HTTP fetch failures do not retry anonymously', async () => {
  const { context } = loadWorker();
  let attempts = 0;
  context.fetch = async () => { attempts++; throw new Error('invalid data'); };
  await assert.rejects(context.fetchImageBlob('data:image/png;base64,bad'), /invalid data/);
  assert.equal(attempts, 1);
});

test('unrecognized formats and URL schemes stop before fetching or injecting', async () => {
  const { context, injections, downloads } = loadWorker();
  context.fetch = () => assert.fail('Unexpected fetch');
  for (const formatId of ['constructor', '__proto__', 'gif']) {
    assert.equal(context.getFormatIdFromMenu(`save-image-as:${formatId}`), null);
    await assert.rejects(context.handleImageSave({ ...request, formatId }), /Unsupported/);
  }
  await assert.rejects(context.handleImageSave({ ...request, srcUrl: 'javascript:alert(1)' }), /URL is not supported/);
  assert.equal(injections.length, 0);
  assert.equal(downloads.length, 0);
});

test('an oversized declared response is canceled without decoding or page retry', async () => {
  const { context, injections } = loadWorker();
  let canceled = false;
  context.fetch = async () => ({
    ok: true, headers: new Headers({ 'content-length': String(33 * 1024 * 1024) }),
    body: { cancel: async () => { canceled = true; }, getReader() { assert.fail('Must not read body'); } }
  });
  context.createImageBitmap = () => assert.fail('Must not decode oversized input');
  await assert.rejects(context.handleImageSave(request), /32 MiB/);
  assert.equal(canceled, true);
  assert.equal(injections.length, 0);
});

test('streamed images are bounded even without a Content-Length header', async () => {
  const { context, injections } = loadWorker();
  let canceled = false;
  context.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(32 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { canceled = true; }
  }));
  await assert.rejects(context.handleImageSave(request), /32 MiB/);
  assert.equal(canceled, true);
  assert.equal(injections.length, 0);
});

test('bounded streaming preserves image bytes and MIME type', async () => {
  const { context } = loadWorker();
  context.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
      controller.enqueue(Uint8Array.of(3));
      controller.close();
    }
  }), { headers: { 'content-type': 'image/png' } });
  const blob = await context.fetchImageBlob(request.srcUrl);
  assert.equal(blob.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
});

test('oversized decoded images close their bitmap without a canvas or page retry', async () => {
  const { context, injections } = loadWorker();
  let closed = false;
  context.createImageBitmap = async () => ({ width: 10_000, height: 10_000, close() { closed = true; } });
  context.OffscreenCanvas = class { constructor() { assert.fail('Must not allocate canvas'); } };
  await assert.rejects(context.handleImageSave(request), /64 megapixel/);
  assert.equal(closed, true);
  assert.equal(injections.length, 0);
  assert.throws(() => context.validateImageSize(32768, 1), /dimension limit/);
  assert.throws(() => context.validateImageSize(0, 1), /drawable size/);
});

test('oversized encoded output is rejected', () => {
  const { context } = loadWorker();
  assert.throws(() => context.validateConvertedBlob({ size: 65 * 1024 * 1024, type: 'image/png' },
    { mimeType: 'image/png' }), /64 MiB/);
});

test('canvas backing storage is released on success and encoding failure', async () => {
  const { context } = loadWorker();
  const canvases = [];
  context.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return { drawImage() {} }; }
    async convertToBlob({ type }) { return new Blob(['image'], { type }); }
  };
  await context.convertBlob(new Blob(['x']), { mimeType: 'image/png' });
  context.OffscreenCanvas.prototype.convertToBlob = async () => { throw new Error('encoder failed'); };
  await assert.rejects(context.convertBlob(new Blob(['x']), { mimeType: 'image/png' }), /encoder failed/);
  assert.ok(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test('document image loading times out and detaches handlers and its owned request', async () => {
  const { context } = loadWorker();
  let image, expire;
  context.Image = class { constructor() { image = this; } };
  context.setTimeout = (callback) => { expire = callback; return 1; };
  const loading = context.loadImageElement('blob:source');
  expire();
  await assert.rejects(loading, /Timed out/);
  assert.equal(image.src, '');
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
});

test('page fallback times out and cancels only extension-owned images', async () => {
  const worker = loadWorker();
  mockPage(worker, []);
  let owned, expire;
  worker.context.Image = class {
    constructor() { owned = this; }
    decode() { return new Promise(() => {}); }
  };
  worker.context.setTimeout = (callback) => { expire = callback; return 1; };
  const saving = worker.context.convertFromPageContext(pageRequest);
  expire();
  await assert.rejects(saving, /Timed out/);
  assert.equal(owned.src, '');
});

test('a complete visible image is drawn without awaiting decode or changing its src', async () => {
  const worker = loadWorker();
  const visible = { src: pageRequest.srcUrl, complete: true, naturalWidth: 4, naturalHeight: 3,
    decode() { assert.fail('Complete visible image must not await decode'); } };
  const drawn = mockPage(worker, [visible]);
  await worker.context.convertFromPageContext(pageRequest);
  assert.equal(drawn.length, 1);
  assert.equal(visible.src, pageRequest.srcUrl);
});

test('page fallback rejects oversized images before allocating a canvas', async () => {
  const worker = loadWorker();
  mockPage(worker, [{ src: pageRequest.srcUrl, complete: true, naturalWidth: 9000, naturalHeight: 9000 }]);
  worker.context.document.createElement = () => assert.fail('Must not allocate canvas');
  await assert.rejects(worker.context.convertFromPageContext(pageRequest), /64 megapixel/);
});

test('erasing a download releases its object URL once', async () => {
  const { context, events, revoked } = loadWorker();
  await context.startDownload('blob:converted', 'image.png', false);
  events.downloadErased(1);
  events.downloadChanged({ id: 1, state: { current: 'complete' } });
  assert.deepEqual(revoked, ['blob:converted']);
});

test('malformed settings use defaults while valid quality values are clamped', async () => {
  const { context, api } = loadWorker();
  for (const value of [null, false, '', ' ', {}, [], 'invalid', Infinity]) {
    api.storage.sync.get = async () => ({ jpegQuality: value, webpQuality: value, saveAsDialog: value });
    const settings = await context.getSettings();
    assert.equal(settings.jpegQuality, 0.92);
    assert.equal(settings.webpQuality, 0.9);
    assert.equal(settings.saveAsDialog, typeof value === 'boolean' ? value : true);
  }
  assert.equal(context.normalizeQuality(0, 0.92), 0.1);
  assert.equal(context.normalizeQuality('0.75', 0.92), 0.75);
  assert.equal(context.normalizeQuality(2, 0.92), 1);
});

test('Windows reserved superscript device names are sanitized', () => {
  const { context } = loadWorker();
  for (const name of ['COM¹', 'com²', 'COM³.preview', 'LPT¹', 'lpt²', 'LPT³.other']) {
    assert.equal(context.sanitizeFilename(name), `_${name}`);
  }
});

test('interrupted downloads report disk errors, but user cancellation stays quiet', async () => {
  for (const error of ['FILE_ACCESS_DENIED', 'USER_CANCELED']) {
    const { context, api, events, revoked } = loadWorker();
    const titles = [];
    api.action.setTitle = async ({ title }) => titles.push(title);
    await context.startDownload('blob:converted', 'image.png', false, 7);
    events.downloadChanged({ id: 1, state: { current: 'interrupted' }, error: { current: error } });
    await Promise.resolve();
    assert.deepEqual(revoked, ['blob:converted']);
    assert.equal(titles.length, error === 'USER_CANCELED' ? 0 : 1);
    if (titles.length) assert.match(titles[0], /FILE_ACCESS_DENIED/);
  }
});

test('early download interruptions are reported after the ID arrives', async () => {
  const { context, api } = loadWorker();
  const titles = [];
  api.action.setTitle = async ({ title }) => titles.push(title);
  api.downloads.search = async () => [{ id: 1, state: 'interrupted', error: 'FILE_FAILED' }];
  await context.startDownload('data:image/png;base64,AA==', 'image.png', false, 7);
  assert.match(titles[0], /FILE_FAILED/);
});

test('an older failure timer cannot clear a newer failure badge', async () => {
  const { context, api } = loadWorker();
  const timers = [], texts = [];
  context.setTimeout = (callback) => timers.push(callback);
  api.action.setBadgeText = async ({ text }) => texts.push(text);
  await context.showFailureBadge(7, 'first error');
  await context.showFailureBadge(7, 'second error');
  timers[0]();
  assert.deepEqual(texts, ['!', '!']);
  timers[1]();
  assert.deepEqual(texts, ['!', '!', '']);
});
