const extensionApi = globalThis.browser ?? globalThis.chrome;

document.getElementById('open-settings').addEventListener('click', async () => {
  await extensionApi.runtime.openOptionsPage();
  window.close();
});
