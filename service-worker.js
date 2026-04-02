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

chrome.runtime.onInstalled.addListener(async () => {
  await createContextMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  await createContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
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

async function createContextMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: ROOT_MENU_ID,
    title: 'Save image as',
    contexts: ['image']
  });

  for (const format of Object.values(FORMATS)) {
    chrome.contextMenus.create({
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
    const dataUrl = await convertRemoteImage(srcUrl, format, quality);
    await downloadDataUrl(dataUrl, filename, settings.saveAsDialog);
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
  const values = await chrome.storage.sync.get(DEFAULT_SETTINGS);
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

    return await blobToDataUrl(convertedBlob);
  } finally {
    imageBitmap.close();
  }
}

async function saveFromPageContext({ filename, format, frameId, quality, saveAsDialog, srcUrl, tabId }) {
  if (typeof tabId !== 'number') {
    throw new Error('A browser tab is required for page-context fallback.');
  }

  const target = { tabId };
  if (typeof frameId === 'number') {
    target.frameIds = [frameId];
  }

  const injectionResults = await chrome.scripting.executeScript({
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

        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Unable to read the converted image.'));
          reader.readAsDataURL(convertedBlob);
        });

        return {
          ok: true,
          dataUrl,
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

  await downloadDataUrl(result.dataUrl, filename, saveAsDialog);
}

async function showFailureBadge(tabId, message) {
  if (typeof tabId !== 'number') {
    return;
  }

  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: '#b42318'
  });
  await chrome.action.setBadgeText({
    tabId,
    text: '!'
  });
  await chrome.action.setTitle({
    tabId,
    title: `Save Image As: ${message}`
  });

  setTimeout(async () => {
    await chrome.action.setBadgeText({
      tabId,
      text: ''
    });
    await chrome.action.setTitle({
      tabId,
      title: 'Save Image As'
    });
  }, 5000);
}

async function downloadDataUrl(dataUrl, filename, saveAsDialog) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('The converted image could not be prepared for download.');
  }

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: saveAsDialog,
    conflictAction: 'uniquify'
  });
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
