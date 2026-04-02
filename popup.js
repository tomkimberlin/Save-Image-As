document.getElementById('open-settings').addEventListener('click', async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});
