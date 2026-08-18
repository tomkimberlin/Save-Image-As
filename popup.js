const extensionApi = globalThis.browser ?? globalThis.chrome;

document.getElementById('open-settings').addEventListener('click', async () => {
  try {
    await extensionApi.runtime.openOptionsPage();
    window.close();
  } catch (error) {
    console.error('Unable to open settings.', error);
  }
});
