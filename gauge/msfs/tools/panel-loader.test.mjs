import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('panel loads the CDU when an empty iframe src resolves to the panel URL', async () => {
  let active;
  const attributes = new Map([['src', '']]);
  const frame = {
    // Browser/Coherent exposes an absolute URL here even though the attribute is empty.
    src: 'coui://html_ui/InGamePanels/MSFSLoggerCDU/MSFSLoggerCDUPanel.html',
    contentWindow: {},
    getAttribute: name => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const ui = { addEventListener: (name, fn) => { if (name === 'panelActive') active = fn; } };
  class TemplateElement { querySelector(selector) { return selector === 'ingame-ui' ? ui : frame; } connectedCallback() {} }
  const registry = {};
  const window = { customElements: { define: (name, type) => { registry[name] = type; } } };
  const context = vm.createContext({ window, TemplateElement, checkAutoload() {} });
  vm.runInContext(await readFile(new URL('../src/MSFSLoggerCDUPanel.js', import.meta.url), 'utf8'), context);
  new registry['msfslogger-cdu-panel']().connectedCallback();
  active();
  assert.equal(attributes.get('src'), '/Pages/VCockpit/Instruments/MSFSLoggerCDU/MSFSLoggerCDU.html?v=0.1.1');
});

test('gauge-bound UI source avoids unsupported Coherent collection methods', async () => {
  const pageSource = await readFile(new URL('../../../ui/src/pages/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pageSource, /\.flat\s*\(/);
});
