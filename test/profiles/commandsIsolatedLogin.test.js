'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadCommandsModule(mock) {
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/commands')];
  const mod = require('../../src/profiles/commands');
  return { mod, restore };
}

test('isolated login browser launcher uses a separate browser profile and no logout command', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-launcher-test-'));
  const fakeChrome = path.join(directory, 'chrome.exe');
  fs.writeFileSync(fakeChrome, '');
  const mock = createMockVscode();
  const { mod, restore } = loadCommandsModule(mock);

  try {
    const launcher = mod.createWindowsBrowserLauncher(directory, {
      browserExecutable: fakeChrome
    });

    const script = fs.readFileSync(launcher.launcherPath, 'utf8');
    assert.match(script, /--user-data-dir=/);
    assert.match(script, /--no-first-run/);
    assert.match(script, /--new-window/);
    assert.doesNotMatch(script, /\blogout\b/i);
    assert.equal(launcher.userDataDir, path.join(directory, 'browser-profile'));
  } finally {
    restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Windows browser discovery prefers local Chrome or Edge paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-browser-discovery-test-'));
  const localAppData = path.join(root, 'LocalAppData');
  const chrome = path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe');
  fs.mkdirSync(path.dirname(chrome), { recursive: true });
  fs.writeFileSync(chrome, '');
  const mock = createMockVscode();
  const { mod, restore } = loadCommandsModule(mock);

  try {
    assert.equal(
      mod.findWindowsBrowserExecutable({
        LOCALAPPDATA: localAppData,
        ProgramFiles: path.join(root, 'ProgramFiles'),
        'ProgramFiles(x86)': path.join(root, 'ProgramFilesX86')
      }),
      chrome
    );
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
