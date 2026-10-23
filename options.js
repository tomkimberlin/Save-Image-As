const extensionApi = globalThis.browser ?? globalThis.chrome;

const DEFAULT_SETTINGS = {
  jpegQuality: 0.92,
  webpQuality: 0.9,
  saveAsDialog: true
};

const elements = {
  form: document.getElementById('settings-form'),
  fields: document.getElementById('settings-fields'),
  jpegQuality: document.getElementById('jpeg-quality'),
  jpegQualityValue: document.getElementById('jpeg-quality-value'),
  webpQuality: document.getElementById('webp-quality'),
  webpQualityValue: document.getElementById('webp-quality-value'),
  saveAsDialog: document.getElementById('save-as-dialog'),
  resetButton: document.getElementById('reset-button'),
  status: document.getElementById('status')
};

let statusTimeoutId;
let busy = true;

init().catch((error) => {
  console.error('Unable to initialize settings page.', error);
  setStatus('Unable to load settings. Reload this page to try again.', true);
});

async function init() {
  setBusy(true);
  bindEvents();
  const settings = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  hydrateForm(settings);
  setBusy(false);
}

function setBusy(value) {
  busy = value;
  elements.fields.disabled = value;
  elements.form.setAttribute('aria-busy', String(value));
}

function bindEvents() {
  elements.jpegQuality.addEventListener('input', () => {
    updateQualityOutput(elements.jpegQuality, elements.jpegQualityValue);
  });

  elements.webpQuality.addEventListener('input', () => {
    updateQualityOutput(elements.webpQuality, elements.webpQualityValue);
  });

  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings().catch((error) => {
      console.error('Unable to save settings.', error);
      setStatus('Unable to save settings.', true);
    });
  });

  elements.resetButton.addEventListener('click', () => {
    void resetSettings().catch((error) => {
      console.error('Unable to reset settings.', error);
      setStatus('Unable to reset settings.', true);
    });
  });
}

function hydrateForm(settings) {
  elements.jpegQuality.value = normalizeQuality(settings.jpegQuality, DEFAULT_SETTINGS.jpegQuality);
  elements.webpQuality.value = normalizeQuality(settings.webpQuality, DEFAULT_SETTINGS.webpQuality);
  elements.saveAsDialog.checked = normalizeBoolean(
    settings.saveAsDialog,
    DEFAULT_SETTINGS.saveAsDialog
  );
  updateQualityOutput(elements.jpegQuality, elements.jpegQualityValue);
  updateQualityOutput(elements.webpQuality, elements.webpQualityValue);
}

function updateQualityOutput(input, output) {
  output.value = `${Math.round(Number(input.value) * 100)}%`;
}

async function saveSettings() {
  if (busy) return;
  const nextSettings = {
    jpegQuality: normalizeQuality(elements.jpegQuality.value, DEFAULT_SETTINGS.jpegQuality),
    webpQuality: normalizeQuality(elements.webpQuality.value, DEFAULT_SETTINGS.webpQuality),
    saveAsDialog: elements.saveAsDialog.checked
  };

  await persistSettings(nextSettings, false);
}

async function resetSettings() {
  if (busy) return;
  await persistSettings(DEFAULT_SETTINGS, true);
}

async function persistSettings(settings, reset) {
  setBusy(true);
  try {
    await extensionApi.storage.sync.set(settings);
    if (reset) hydrateForm(settings);
    setStatus(reset ? 'Settings reset to defaults.' : 'Settings saved.');
  } finally {
    setBusy(false);
  }
}

function normalizeQuality(value, fallback) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) {
    return fallback;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(1, Math.max(0.1, numericValue));
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
  window.clearTimeout(statusTimeoutId);
  if (isError) return;
  statusTimeoutId = window.setTimeout(() => {
    elements.status.textContent = '';
    elements.status.classList.remove('error');
  }, 2200);
}
