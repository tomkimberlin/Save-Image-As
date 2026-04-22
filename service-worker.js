const extensionApi = globalThis.browser ?? globalThis.chrome;

const ROOT_MENU_ID = 'save-image-as-root';
const MENU_PREFIX = 'save-image-as:';

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

extensionApi.runtime.onInstalled.addListener(async () => {
  await createContextMenus();
});

extensionApi.runtime.onStartup.addListener(async () => {
  await createContextMenus();
});

extensionApi.contextMenus.onClicked.addListener(async (info, tab) => {
  const formatId = getFormatIdFromMenu(info.menuItemId);
  if (!formatId || !info.srcUrl) {
    return;
  }

  try {
    await handleImageSave({
      formatId,
      frameId: info.frameId,
      pageUrl: info.pageUrl,
      srcUrl: info.srcUrl,
      tab
    });
  } catch (error) {
    console.error('Save Image As failed.', error);
    await showFailureBadge(tab?.id, error?.message || 'Unable to save this image');
  }
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
    contexts: ['image']
  });

  for (const format of Object.values(FORMATS)) {
    extensionApi.contextMenus.create({
      id: `${MENU_PREFIX}${format.id}`,
      parentId: ROOT_MENU_ID,
      title: format.label,
      contexts: ['image']
    });
  }
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

  if (isPageScopedUrl(srcUrl)) {
    await saveFromPageContext({
      filename,
      format,
      frameId,
      quality,
      saveAsDialog: settings.saveAsDialog,
      srcUrl,
      tabId: tab?.id
    });
    return;
  }

  try {
    const convertedBlob = await convertRemoteImage(srcUrl, format, quality);
    await downloadBlob(convertedBlob, filename, settings.saveAsDialog);
  } catch (error) {
    console.warn('Worker-side conversion failed, attempting page fallback.', error);
    await saveFromPageContext({
      filename,
      format,
      frameId,
      quality,
      saveAsDialog: settings.saveAsDialog,
      srcUrl,
      tabId: tab?.id
    });
  }
}

async function getSettings() {
  const values = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  return {
    jpegQuality: normalizeQuality(values.jpegQuality, DEFAULT_SETTINGS.jpegQuality),
    webpQuality: normalizeQuality(values.webpQuality, DEFAULT_SETTINGS.webpQuality),
    saveAsDialog: Boolean(values.saveAsDialog)
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

async function convertRemoteImage(srcUrl, format, quality) {
  const response = await fetch(srcUrl, {
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`Image request failed with status ${response.status}.`);
  }

  const sourceBlob = await response.blob();
  if (!sourceBlob.size) {
    throw new Error('The source image is empty.');
  }

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

    return await canvas.convertToBlob({
      type: format.mimeType,
      quality
    });
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

    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error(`The browser could not encode ${format.label}.`));
          return;
        }

        resolve(blob);
      }, format.mimeType, quality);
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadImageElement(src) {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The source image could not be decoded.'));
    image.src = src;
  });
}

async function saveFromPageContext({ filename, format, frameId, quality, saveAsDialog, srcUrl, tabId }) {
  if (typeof tabId !== 'number') {
    throw new Error('A browser tab is required for page-context fallback.');
  }

  const target = { tabId };
  if (typeof frameId === 'number') {
    target.frameIds = [frameId];
  }

  const injectionResults = await extensionApi.scripting.executeScript({
    target,
    func: async ({ fallbackFilename, fallbackQuality, fallbackSrcUrl, formatSpec }) => {
      try {
        const collectImages = (root, results) => {
          const scope = root instanceof Document || root instanceof ShadowRoot ? root : document;

          for (const image of scope.querySelectorAll('img')) {
            results.push(image);
          }

          for (const element of scope.querySelectorAll('*')) {
            if (element.shadowRoot) {
              collectImages(element.shadowRoot, results);
            }
          }
        };

        const matchesSource = (imageUrl) => imageUrl === fallbackSrcUrl;
        const images = [];
        collectImages(document, images);

        const match =
          images.find((image) => matchesSource(image.currentSrc)) ||
          images.find((image) => matchesSource(image.src));

        if (!match) {
          return {
            ok: false,
            error: 'No matching image element was found in the page.'
          };
        }

        const width = match.naturalWidth || match.width;
        const height = match.naturalHeight || match.height;
        if (!width || !height) {
          return {
            ok: false,
            error: 'The selected image has no drawable size.'
          };
        }

        if (typeof match.decode === 'function') {
          try {
            await match.decode();
          } catch {
            // Ignore decode failures and draw the already-visible image.
          }
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

        if (!convertedBlob) {
          return {
            ok: false,
            error: `The browser could not encode ${formatSpec.label}.`
          };
        }

        const arrayBuffer = await convertedBlob.arrayBuffer();

        return {
          ok: true,
          bytes: Array.from(new Uint8Array(arrayBuffer)),
          filename: fallbackFilename
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
        fallbackFilename: filename,
        fallbackQuality: quality,
        fallbackSrcUrl: srcUrl,
        formatSpec: format
      }
    ]
  });

  const result = injectionResults?.[0]?.result;
  if (!result?.ok) {
    throw new Error(`Page fallback failed: ${result?.error || 'Unknown page error.'}`);
  }

  if (!Array.isArray(result.bytes) || result.bytes.length === 0) {
    throw new Error('Page fallback failed to produce image data.');
  }

  const convertedBlob = new Blob([new Uint8Array(result.bytes)], {
    type: format.mimeType
  });

  await downloadBlob(convertedBlob, filename, saveAsDialog);
}

async function showFailureBadge(tabId, message) {
  if (typeof tabId !== 'number') {
    return;
  }

  await extensionApi.action.setBadgeBackgroundColor({
    tabId,
    color: '#b42318'
  });
  await extensionApi.action.setBadgeText({
    tabId,
    text: '!'
  });
  await extensionApi.action.setTitle({
    tabId,
    title: `Save Image As: ${message}`
  });

  setTimeout(async () => {
    await extensionApi.action.setBadgeText({
      tabId,
      text: ''
    });
    await extensionApi.action.setTitle({
      tabId,
      title: 'Save Image As'
    });
  }, 5000);
}

async function downloadBlob(blob, filename, saveAsDialog) {
  if (!(blob instanceof Blob) || !blob.size) {
    throw new Error('The converted image could not be prepared for download.');
  }

  const downloadUrl = await createDownloadUrl(blob);
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
    throw error;
  }

  if (typeof downloadId === 'number' && downloadUrl.startsWith('blob:')) {
    pendingObjectUrls.set(downloadId, downloadUrl);
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
    reader.onloadend = () => resolve(reader.result);
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
    return pathname ? decodeURIComponent(pathname) : url.hostname;
  } catch {
    return '';
  }
}

function removeExtension(filename) {
  return filename.replace(/\.[a-z0-9]{1,5}$/i, '');
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 180);
}

function normalizeQuality(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(1, Math.max(0.1, numericValue));
}

function isPageScopedUrl(url) {
  return typeof url === 'string' && (url.startsWith('blob:') || url.startsWith('data:'));
}
