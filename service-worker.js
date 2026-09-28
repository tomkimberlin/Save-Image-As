const extensionApi = globalThis.browser ?? globalThis.chrome;

const ROOT_MENU_ID = 'save-image-as-root';
const MENU_PREFIX = 'save-image-as:';
const SUPPORTED_PAGE_PATTERNS = ['http://*/*', 'https://*/*', 'file:///*'];

const FORMATS = {
  png: {
    id: 'png',
    label: 'PNG',
    extension: 'png',
    mimeType: 'image/png'
  },
  jpg: {
    id: 'jpg',
    label: 'JPG',
    extension: 'jpg',
    mimeType: 'image/jpeg'
  },
  webp: {
    id: 'webp',
    label: 'WebP',
    extension: 'webp',
    mimeType: 'image/webp'
  }
};

const DEFAULT_SETTINGS = {
  jpegQuality: 0.92,
  webpQuality: 0.9,
  saveAsDialog: true
};

const pendingObjectUrls = new Map();

extensionApi.runtime.onInstalled.addListener(() => {
  rebuildContextMenus();
});

extensionApi.runtime.onStartup.addListener(() => {
  rebuildContextMenus();
});

extensionApi.contextMenus.onClicked.addListener((info, tab) => {
  const formatId = getFormatIdFromMenu(info.menuItemId);
  if (!formatId || !info.srcUrl || !isSupportedPageUrl(info.pageUrl)) {
    return;
  }

  void handleImageSave({
    formatId,
    frameId: info.frameId,
    pageUrl: info.pageUrl,
    srcUrl: info.srcUrl,
    tab
  }).catch(async (error) => {
    console.warn('Save Image As could not complete.', error);

    try {
      await showFailureBadge(tab?.id, error?.message || 'Unable to save this image');
    } catch (badgeError) {
      console.warn('Unable to show the Save Image As failure badge.', badgeError);
    }
  });
});

extensionApi.downloads.onChanged.addListener((delta) => {
  if (!delta || typeof delta.id !== 'number') {
    return;
  }

  if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
    revokePendingObjectUrl(delta.id);
  }
});

async function createContextMenus() {
  await extensionApi.contextMenus.removeAll();

  extensionApi.contextMenus.create({
    id: ROOT_MENU_ID,
    title: 'Save image as',
    contexts: ['image'],
    documentUrlPatterns: SUPPORTED_PAGE_PATTERNS
  });

  for (const format of Object.values(FORMATS)) {
    extensionApi.contextMenus.create({
      id: `${MENU_PREFIX}${format.id}`,
      parentId: ROOT_MENU_ID,
      title: format.label,
      contexts: ['image'],
      documentUrlPatterns: SUPPORTED_PAGE_PATTERNS
    });
  }
}

function rebuildContextMenus() {
  void createContextMenus().catch((error) => {
    console.error('Unable to create Save Image As context menus.', error);
  });
}

function getFormatIdFromMenu(menuItemId) {
  if (typeof menuItemId !== 'string' || !menuItemId.startsWith(MENU_PREFIX)) {
    return null;
  }

  return menuItemId.slice(MENU_PREFIX.length);
}

async function handleImageSave({ formatId, frameId, pageUrl, srcUrl, tab }) {
  const format = FORMATS[formatId];
  if (!format) {
    throw new Error(`Unsupported target format: ${formatId}`);
  }

  const settings = await getSettings();
  const quality = getQualityForFormat(formatId, settings);
  const filenameBase = buildFilenameBase(srcUrl, pageUrl);
  const filename = `${filenameBase}.${format.extension}`;

  const pageConversion = { format, frameId, quality, srcUrl, tabId: tab?.id };
  let downloadUrl;

  if (srcUrl.startsWith('blob:')) {
    downloadUrl = await convertFromPageContext(pageConversion);
  } else {
    let sourceBlob;
    try {
      // Data URLs are self-contained and can be decoded without accessing the page.
      sourceBlob = await fetchImageBlob(srcUrl);
      const convertedBlob = await convertBlob(sourceBlob, format, quality);
      downloadUrl = await createDownloadUrl(convertedBlob);
    } catch (error) {
      console.warn('Background conversion failed, attempting page fallback.', error);
      downloadUrl = await convertFromPageContext({
        ...pageConversion,
        // Chromium cannot decode SVG blobs with createImageBitmap. Reuse the
        // fetched bytes so the page canvas can draw cross-origin SVGs safely.
        sourceDataUrl: sourceBlob ? await blobToDataUrl(sourceBlob) : undefined
      });
    }
  }

  // A canceled or failed download must never trigger another conversion/dialog.
  await startDownload(downloadUrl, filename, settings.saveAsDialog);
}

async function getSettings() {
  const values = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  return {
    jpegQuality: normalizeQuality(values.jpegQuality, DEFAULT_SETTINGS.jpegQuality),
    webpQuality: normalizeQuality(values.webpQuality, DEFAULT_SETTINGS.webpQuality),
    saveAsDialog: normalizeBoolean(values.saveAsDialog, DEFAULT_SETTINGS.saveAsDialog)
  };
}

function getQualityForFormat(formatId, settings) {
  if (formatId === 'jpg') {
    return settings.jpegQuality;
  }

  if (formatId === 'webp') {
    return settings.webpQuality;
  }

  return undefined;
}

async function fetchImageBlob(srcUrl) {
  const signal = AbortSignal.timeout(20_000);
  let response;
  try {
    response = await fetch(srcUrl, { credentials: 'include', signal });
  } catch (error) {
    // Restricted hosts such as addons.mozilla.org still enforce CORS in the
    // background. Their public images can allow anonymous requests (*) while
    // rejecting credentials. Retry without cookies before needing page access.
    if (signal.aborted || !/^https?:/i.test(srcUrl)) {
      throw error;
    }
    response = await fetch(srcUrl, { credentials: 'omit', signal });
  }

  if (!response.ok) {
    throw new Error(`Image request failed with status ${response.status}.`);
  }

  const sourceBlob = await response.blob();
  if (!sourceBlob.size) {
    throw new Error('The source image is empty.');
  }

  return sourceBlob;
}

async function convertBlob(sourceBlob, format, quality) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    return await convertBlobWithDocumentCanvas(sourceBlob, format, quality);
  }

  const imageBitmap = await createImageBitmap(sourceBlob);

  try {
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const context = canvas.getContext('2d', {
      alpha: format.mimeType !== 'image/jpeg'
    });

    if (!context) {
      throw new Error('Unable to create a 2D drawing context.');
    }

    if (format.mimeType === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }

    context.drawImage(imageBitmap, 0, 0);

    const convertedBlob = await canvas.convertToBlob({
      type: format.mimeType,
      quality
    });
    return validateConvertedBlob(convertedBlob, format);
  } finally {
    imageBitmap.close();
  }
}

async function convertBlobWithDocumentCanvas(sourceBlob, format, quality) {
  const objectUrl = URL.createObjectURL(sourceBlob);

  try {
    const image = await loadImageElement(objectUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (!width || !height) {
      throw new Error('The source image has no drawable size.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d', {
      alpha: format.mimeType !== 'image/jpeg'
    });

    if (!context) {
      throw new Error('Unable to create a 2D drawing context.');
    }

    if (format.mimeType === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }

    context.drawImage(image, 0, 0, width, height);

    const convertedBlob = await new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob);
      }, format.mimeType, quality);
    });
    return validateConvertedBlob(convertedBlob, format);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function validateConvertedBlob(blob, format) {
  // Canvas encoders may silently return PNG when the requested type is unsupported.
  if (!blob?.size || blob.type !== format.mimeType) {
    throw new Error(`The browser could not encode ${format.label}.`);
  }
  return blob;
}

async function loadImageElement(src) {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The source image could not be decoded.'));
    image.src = src;
  });
}

async function convertFromPageContext({ format, frameId, quality, srcUrl, sourceDataUrl, tabId }) {
  if (typeof tabId !== 'number') {
    throw new Error('A browser tab is required for page-context fallback.');
  }

  const target = { tabId };
  if (typeof frameId === 'number') {
    target.frameIds = [frameId];
  }

  const injectionResults = await extensionApi.scripting.executeScript({
    target,
    func: async ({ fallbackQuality, fallbackSrcUrl, sourceDataUrl, formatSpec }) => {
      try {
        const findMatchingImage = (root) => {
          for (const image of root.querySelectorAll('img')) {
            if ((image.currentSrc || image.src) === fallbackSrcUrl) {
              return image;
            }
          }

          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) {
              const match = findMatchingImage(element.shadowRoot);
              if (match) {
                return match;
              }
            }
          }

          return null;
        };

        let match;
        if (sourceDataUrl) {
          const image = new Image();
          image.src = sourceDataUrl;
          try {
            await image.decode();
            match = image;
          } catch {
            // A fresh request may return a login page while the original image
            // remains drawable in the tab. Keep the visible-image fallback.
          }
        }
        match ||= findMatchingImage(document);
        if (!match) {
          match = new Image();
          if (/^https?:/.test(fallbackSrcUrl)) {
            match.crossOrigin = 'use-credentials';
          }
          match.src = fallbackSrcUrl;
          await match.decode();
        } else if (typeof match.decode === 'function') {
          try {
            await match.decode();
          } catch {
            // Ignore decode failures and draw the already-visible image.
          }
        }

        const width = match.naturalWidth || match.width;
        const height = match.naturalHeight || match.height;
        if (!width || !height) {
          return {
            ok: false,
            error: 'The selected image has no drawable size.'
          };
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d', {
          alpha: formatSpec.mimeType !== 'image/jpeg'
        });

        if (!context) {
          return {
            ok: false,
            error: 'Unable to create a 2D drawing context.'
          };
        }

        if (formatSpec.mimeType === 'image/jpeg') {
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
        }

        context.drawImage(match, 0, 0, width, height);

        const convertedBlob = await new Promise((resolve, reject) => {
          try {
            canvas.toBlob((blob) => resolve(blob), formatSpec.mimeType, fallbackQuality);
          } catch (error) {
            reject(error);
          }
        });

        if (!convertedBlob?.size || convertedBlob.type !== formatSpec.mimeType) {
          return {
            ok: false,
            error: `The browser could not encode ${formatSpec.label}.`
          };
        }

        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === 'string' && reader.result.startsWith('data:')) {
              resolve(reader.result);
              return;
            }

            reject(new Error('The converted image could not be serialized.'));
          };
          reader.onerror = () => reject(new Error('The converted image could not be read.'));
          reader.readAsDataURL(convertedBlob);
        });

        return {
          ok: true,
          dataUrl
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    },
    args: [
      {
        fallbackQuality: quality,
        fallbackSrcUrl: srcUrl,
        sourceDataUrl: sourceDataUrl || null,
        formatSpec: format
      }
    ]
  });

  const result = injectionResults?.[0]?.result;
  if (!result?.ok) {
    throw new Error(`Page fallback failed: ${result?.error || 'Unknown page error.'}`);
  }

  if (
    typeof result.dataUrl !== 'string' ||
    !result.dataUrl.startsWith(`data:${format.mimeType};base64,`)
  ) {
    throw new Error('Page fallback failed to produce image data.');
  }

  // Firefox rejects data URLs in downloads.download. Recreate the converted
  // blob in the extension so its object URL has the correct owner and lifetime.
  if (typeof URL.createObjectURL === 'function' && typeof URL.revokeObjectURL === 'function') {
    const blob = await (await fetch(result.dataUrl)).blob();
    return createDownloadUrl(validateConvertedBlob(blob, format));
  }

  return result.dataUrl;
}

async function showFailureBadge(tabId, message) {
  if (typeof tabId !== 'number') {
    return;
  }

  await Promise.all([
    extensionApi.action.setBadgeBackgroundColor({
      tabId,
      color: '#b42318'
    }),
    extensionApi.action.setBadgeText({
      tabId,
      text: '!'
    }),
    extensionApi.action.setTitle({
      tabId,
      title: `Save Image As: ${message}`
    })
  ]);

  setTimeout(() => {
    void Promise.all([
      extensionApi.action.setBadgeText({
        tabId,
        text: ''
      }),
      extensionApi.action.setTitle({
        tabId,
        title: 'Save Image As'
      })
    ]).catch(() => {
      // The tab may have closed before the temporary badge was cleared.
    });
  }, 5000);
}

async function startDownload(downloadUrl, filename, saveAsDialog) {
  if (typeof downloadUrl !== 'string' || !/^(?:blob|data):/.test(downloadUrl)) {
    throw new Error('The converted image did not produce a valid download URL.');
  }

  let downloadId;

  try {
    downloadId = await extensionApi.downloads.download({
      url: downloadUrl,
      filename,
      saveAs: saveAsDialog,
      conflictAction: 'uniquify'
    });
  } catch (error) {
    revokeDownloadUrl(downloadUrl);
    if (/^(?:Download cancel(?:l)?ed(?: by the user)?\.?|USER_CANCELED)$/i.test(error?.message || '')) {
      return;
    }
    throw error;
  }

  if (typeof downloadId === 'number' && downloadUrl.startsWith('blob:')) {
    pendingObjectUrls.set(downloadId, downloadUrl);
    // A small download can finish before downloads.download() resolves.
    try {
      const [download] = await extensionApi.downloads.search({ id: downloadId });
      if (!download || download.state === 'complete' || download.state === 'interrupted') {
        revokePendingObjectUrl(downloadId);
      }
    } catch (error) {
      console.warn('Unable to check download completion.', error);
    }
    return;
  }

  if (downloadUrl.startsWith('blob:')) {
    setTimeout(() => {
      revokeDownloadUrl(downloadUrl);
    }, 60_000);
  }
}

function revokePendingObjectUrl(downloadId) {
  const downloadUrl = pendingObjectUrls.get(downloadId);
  if (!downloadUrl) {
    return;
  }

  pendingObjectUrls.delete(downloadId);
  revokeDownloadUrl(downloadUrl);
}

async function createDownloadUrl(blob) {
  if (typeof URL.createObjectURL === 'function' && typeof URL.revokeObjectURL === 'function') {
    return URL.createObjectURL(blob);
  }

  return await blobToDataUrl(blob);
}

function revokeDownloadUrl(downloadUrl) {
  if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith('blob:')) {
    return;
  }

  URL.revokeObjectURL(downloadUrl);
}

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:')) {
        resolve(reader.result);
        return;
      }

      reject(new Error('The converted image could not be serialized.'));
    };
    reader.onerror = () => reject(new Error('Unable to read the converted image.'));
    reader.readAsDataURL(blob);
  });
}

function buildFilenameBase(srcUrl, pageUrl) {
  const candidates = [];

  for (const value of [srcUrl, pageUrl]) {
    const name = extractFilename(value);
    if (name) {
      candidates.push(name);
    }
  }

  for (const candidate of candidates) {
    const cleaned = sanitizeFilename(removeExtension(candidate));
    if (cleaned) {
      return cleaned;
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `image-${timestamp}`;
}

function extractFilename(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  if (value.startsWith('data:')) {
    return 'image';
  }

  if (value.startsWith('blob:')) {
    return '';
  }

  try {
    const url = new URL(value);
    const pathname = url.pathname.split('/').filter(Boolean).pop();
    if (!pathname) {
      return url.hostname;
    }
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  } catch {
    return '';
  }
}

function removeExtension(filename) {
  return filename.replace(/\.[a-z0-9]{1,5}$/i, '');
}

function sanitizeFilename(filename) {
  const cleaned = filename
    .replace(/[<>:"/\\|?*\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');

  // Leave room for the extension and duplicate suffix on filesystems with a
  // 255-byte filename limit, without splitting emoji or other Unicode characters.
  const encoder = new TextEncoder();
  let sanitized = '';
  let bytes = 0;
  for (const character of cleaned) {
    bytes += encoder.encode(character).length;
    if (bytes > 180) {
      break;
    }
    sanitized += character;
  }
  sanitized = sanitized.replace(/[. ]+$/g, '');

  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)) {
    return `_${sanitized}`;
  }

  return sanitized;
}

function normalizeQuality(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(1, Math.max(0.1, numericValue));
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function isSupportedPageUrl(url) {
  return typeof url === 'string' && /^(?:https?|file):/.test(url);
}
