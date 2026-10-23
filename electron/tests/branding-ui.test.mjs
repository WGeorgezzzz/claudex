import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('launcher keeps local controls without hosted account or environment UI, even with a saved cloud account', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/launcher/', runScripts: 'outside-only' });
  try {
    dom.window.eval(fs.readFileSync(new URL('../launcher/launcher.js', import.meta.url), 'utf8'));
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await new Promise(resolve => setTimeout(resolve, 20));
    const body = dom.window.document.body;
    assert.match(body.textContent, /GACI/);
    assert.match(body.textContent, /Open Local GACI/);
    assert.doesNotMatch(body.textContent, /CloudCLI|Cloud environments|you@cloudcli|not connected/);
    assert.equal(body.querySelector('[data-cc-action="connect"]'), null);
    assert.equal(body.querySelector('[data-cc-action="logout"]'), null);
    assert.equal(body.querySelector('[data-cc-nav="cloud"]'), null);
  } finally { dom.window.close(); }
});

test('native app and tray menus expose local controls without CloudCLI cloud menus', () => {
  const menus = [];
  const context = vm.createContext({ process, Menu: {
    buildFromTemplate: template => { menus.push(template); return template; },
    setApplicationMenu: () => {},
  } });
  const source = fs.readFileSync(new URL('../desktopWindow.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class DesktopWindowManager', 'class DesktopWindowManager');
  vm.runInContext(source + '\nglobalThis.Manager = DesktopWindowManager;', context);
  const manager = Object.create(context.Manager.prototype);
  Object.assign(manager, { mainWindow: {}, appName: 'GACI',
    tray: { setToolTip: () => {}, setContextMenu: () => {} },
    getLocalState: () => ({ localServerRunning: true, desktopSettings: {} }),
    getCloudState: () => { throw new Error('UI must not read the removed cloud account'); },
    actions: { getActiveTarget: () => ({ name: 'Local' }) },
  });
  manager.buildAppMenu();
  const serialized = JSON.stringify(menus);
  assert.match(serialized, /Open Local GACI/);
  assert.doesNotMatch(serialized, /CloudCLI|cloudcli.ai|Cloud Environments|"Cloud"|Logout|Connect.*Account/);
});
