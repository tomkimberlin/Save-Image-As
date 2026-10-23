import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../options.js', import.meta.url), 'utf8');
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loadOptions(storage) {
  const elements = new Map();
  const timers = [];
  const context = vm.createContext({
    browser: { storage: { sync: storage } },
    document: { getElementById(id) {
      const element = { value: '', checked: false, disabled: true, textContent: '', events: {}, attrs: {},
        classList: { toggle() {}, remove() {} },
        addEventListener(event, listener) { this.events[event] = listener; },
        setAttribute(name, value) { this.attrs[name] = value; }
      };
      elements.set(id, element);
      return element;
    } },
    console: { error() {} },
    window: { clearTimeout() {}, setTimeout(callback) { timers.push(callback); return timers.length; } }
  });
  vm.runInContext(source, context);
  return { context, elements, timers };
}

test('settings cannot be saved or reset until loading completes', async () => {
  const read = deferred();
  const writes = [];
  const { context, elements } = loadOptions({ get: () => read.promise, set: async (value) => writes.push(value) });
  assert.equal(elements.get('settings-fields').disabled, true);
  assert.equal(elements.get('settings-form').attrs['aria-busy'], 'true');
  await context.saveSettings();
  await context.resetSettings();
  assert.equal(writes.length, 0);
  read.resolve({ jpegQuality: 0.4, webpQuality: 0.6, saveAsDialog: false });
  await tick();
  assert.equal(elements.get('settings-fields').disabled, false);
  assert.equal(elements.get('jpeg-quality').value, 0.4);
  assert.equal(elements.get('save-as-dialog').checked, false);
});

test('Save and Reset writes cannot overlap and reset hydrates only after persistence', async () => {
  const writes = [];
  const { context, elements } = loadOptions({ get: async (defaults) => defaults,
    set(value) { const write = deferred(); writes.push({ value, ...write }); return write.promise; } });
  await tick();
  elements.get('jpeg-quality').value = '0.5';
  const saving = context.saveSettings();
  await context.resetSettings();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.jpegQuality, 0.5);
  assert.equal(elements.get('settings-fields').disabled, true);
  writes[0].resolve();
  await saving;
  assert.equal(elements.get('settings-fields').disabled, false);
  const resetting = context.resetSettings();
  assert.equal(elements.get('jpeg-quality').value, '0.5');
  writes[1].resolve();
  await resetting;
  assert.equal(elements.get('jpeg-quality').value, 0.92);
  assert.equal(elements.get('status').textContent, 'Settings reset to defaults.');
});

test('storage write failures keep edits and restore controls with a persistent error', async () => {
  const { elements, timers } = loadOptions({ get: async (defaults) => defaults,
    set: async () => { throw new Error('storage unavailable'); } });
  await tick();
  elements.get('jpeg-quality').value = '0.75';
  elements.get('settings-form').events.submit({ preventDefault() {} });
  await tick();
  assert.equal(elements.get('settings-fields').disabled, false);
  assert.equal(elements.get('jpeg-quality').value, '0.75');
  assert.equal(elements.get('status').textContent, 'Unable to save settings.');
  assert.equal(timers.length, 0, 'Error should stay visible until the next action');
});

test('failed initialization keeps controls disabled instead of overwriting unseen settings', async () => {
  const { context, elements, timers } = loadOptions({ get: async () => { throw new Error('offline'); },
    set() { assert.fail('Must not overwrite settings after a failed read'); } });
  await tick();
  await context.saveSettings();
  assert.equal(elements.get('settings-fields').disabled, true);
  assert.match(elements.get('status').textContent, /Unable to load settings.*Reload/);
  assert.equal(timers.length, 0);
});

test('invalid stored quality values hydrate with the same defaults as conversion', async () => {
  const { elements } = loadOptions({ get: async () => ({ jpegQuality: null, webpQuality: false, saveAsDialog: 'false' }) });
  await tick();
  assert.equal(elements.get('jpeg-quality').value, 0.92);
  assert.equal(elements.get('webp-quality').value, 0.9);
  assert.equal(elements.get('save-as-dialog').checked, true);
});
