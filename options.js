const extensionApi = globalThis.browser ?? globalThis.chrome;

const DEFAULT_SETTINGS = {
  jpegQuality: 0.92,
  webpQuality: 0.9,
  saveAsDialog: true
};

const elements = {
  form: document.getElementById('settings-form'),
  jpegQuality: document.getElementById('jpeg-quality'),
  jpegQualityValue: document.getElementById('jpeg-quality-value'),
  webpQuality: document.getElementById('webp-quality'),
  webpQualityValue: document.getElementById('webp-quality-value'),
  saveAsDialog: document.getElementById('save-as-dialog'),
  resetButton: document.getElementById('reset-button'),
  status: document.getElementById('status')
};

init().catch((error) => {
  console.error('Unable to initialize settings page.', error);
  setStatus('Unable to load settings.');
});

async function init() {
  bindEvents();
  const settings = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  hydrateForm(settings);
}

function bindEvents() {
  elements.jpegQuality.addEventListener('input', () => {
    updateQualityOutput(elements.jpegQuality, elements.jpegQualityValue);
  });

  elements.webpQuality.addEventListener('input', () => {
    updateQualityOutput(elements.webpQuality, elements.webpQualityValue);
  });

  elements.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveSettings();
  });

  elements.resetButton.addEventListener('click', async () => {
    hydrateForm(DEFAULT_SETTINGS);
    await extensionApi.storage.sync.set(DEFAULT_SETTINGS);
    setStatus('Settings reset to defaults.');
  });
}

function hydrateForm(settings) {
  elements.jpegQuality.value = normalizeQuality(settings.jpegQuality, DEFAULT_SETTINGS.jpegQuality);
  elements.webpQuality.value = normalizeQuality(settings.webpQuality, DEFAULT_SETTINGS.webpQuality);
  elements.saveAsDialog.checked = Boolean(settings.saveAsDialog);
  updateQualityOutput(elements.jpegQuality, elements.jpegQualityValue);
  updateQualityOutput(elements.webpQuality, elements.webpQualityValue);
}

function updateQualityOutput(input, output) {
  output.value = `${Math.round(Number(input.value) * 100)}%`;
}

async function saveSettings() {
  const nextSettings = {
    jpegQuality: normalizeQuality(elements.jpegQuality.value, DEFAULT_SETTINGS.jpegQuality),
    webpQuality: normalizeQuality(elements.webpQuality.value, DEFAULT_SETTINGS.webpQuality),
    saveAsDialog: elements.saveAsDialog.checked
  };

  await extensionApi.storage.sync.set(nextSettings);
  setStatus('Settings saved.');
}

function normalizeQuality(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(1, Math.max(0.1, numericValue));
}

function setStatus(message) {
  elements.status.textContent = message;
  window.clearTimeout(setStatus.timeoutId);
  setStatus.timeoutId = window.setTimeout(() => {
    elements.status.textContent = '';
  }, 2200);
}
