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
    downloads: {
      onChanged: event('downloadChanged'),
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
    setTimeout: () => 1,
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
      getContext: () => ({ drawImage: (image) => drawn.push(image) }),
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
  assert.deepEqual(drawn, [selected]);
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
  assert.deepEqual(drawn, [visible]);
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
