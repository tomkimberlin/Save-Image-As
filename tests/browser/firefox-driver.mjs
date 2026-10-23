// Firefox's background page is not exposed as a Playwright page. Use Mozilla's
// localhost DevTools protocol solely to install and exercise this temporary add-on.
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { firefox } from 'playwright';

async function connect(port) {
  let socket;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      socket = createConnection({ host: '127.0.0.1', port });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      break;
    } catch (error) { socket.destroy(); if (attempt === 99) throw error; await delay(50); }
  }
  let incoming = Buffer.alloc(0);
  const messages = [], waiters = [];
  const fail = (error) => { for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); } };
  socket.on('error', fail);
  socket.on('end', () => fail(new Error('Firefox debugger closed')));
  socket.on('data', (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    while (true) {
      const separator = incoming.indexOf(':');
      if (separator < 0) break;
      const length = Number(incoming.subarray(0, separator).toString());
      if (incoming.length < separator + 1 + length) break;
      const message = JSON.parse(incoming.subarray(separator + 1, separator + 1 + length));
      incoming = incoming.subarray(separator + 1 + length);
      const index = waiters.findIndex((waiter) => waiter.matches(message));
      if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
      else messages.push(message);
    }
  });
  function take(matches) {
    const index = messages.findIndex(matches);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, reject, timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Firefox debugger response timed out'));
      }, 10_000) };
      waiters.push(waiter);
    });
  }
  async function request(packet) {
    const reply = take((message) => message.from === packet.to && !message.type);
    const data = JSON.stringify(packet);
    socket.write(`${Buffer.byteLength(data)}:${data}`);
    const result = await reply;
    if (result.error) throw new Error(result.message || result.error);
    return result;
  }
  await take((message) => message.from === 'root');
  return { request, take, close() { fail(new Error('Firefox test finished')); socket.destroy(); } };
}

export async function launchFirefox(profile, downloadPath, extension) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const context = await firefox.launchPersistentContext(profile, { headless: true,
    args: ['-start-debugger-server', String(port)], firefoxUserPrefs: {
      'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false,
      'devtools.debugger.force-local': true,
      'browser.download.folderList': 2, 'browser.download.dir': downloadPath,
      'browser.download.useDownloadDir': true,
      'browser.helperApps.neverAsk.saveToDisk': 'image/png,image/jpeg,image/webp'
    } });
  let client;
  try {
    client = await connect(port);
    const root = await client.request({ to: 'root', type: 'getRoot' });
    await client.request({ to: root.addonsActor, type: 'installTemporaryAddon', addonPath: extension });
    const { addons } = await client.request({ to: 'root', type: 'listAddons' });
    const addon = addons.find((item) => item.id === 'save-image-as@tomkimberlin.addons');
    const watcher = await client.request({ to: addon.actor, type: 'getWatcher', isServerTargetSwitchingEnabled: true });
    await client.request({ to: watcher.actor, type: 'watchTargets', targetType: 'frame' });
    const { target } = await client.take((message) => message.type === 'target-available-form' &&
      message.target.url.endsWith('/_generated_background_page.html'));
    async function evaluateText(text) {
      const { resultID } = await client.request({ to: target.consoleActor, type: 'evaluateJSAsync', text });
      const result = await client.take((message) => message.type === 'evaluationResult' && message.resultID === resultID);
      if (result.hasException) throw new Error(result.exceptionMessage);
      return result.result;
    }
    const worker = { async evaluate(fn, argument) {
      await evaluateText(`globalThis.__fixtureResult = undefined;
        (async () => { try { globalThis.__fixtureResult = JSON.stringify({ok:true,value:await (${fn})(${JSON.stringify(argument)})}); }
        catch (error) { globalThis.__fixtureResult = JSON.stringify({ok:false,error:error.message}); } })(); void 0;`);
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        const value = await evaluateText('globalThis.__fixtureResult');
        if (typeof value === 'string') { const result = JSON.parse(value); if (!result.ok) throw new Error(result.error); return result.value; }
        await delay(25);
      }
      throw new Error('Firefox test evaluation timed out');
    } };
    return { context, worker, close: () => client.close() };
  } catch (error) { client?.close(); await context.close(); throw error; }
}
