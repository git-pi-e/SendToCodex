'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const MODULE_PATH = '../../src/codex/CodexPostSwitchWarmup';

function loadWarmupModule(mock) {
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve(MODULE_PATH)];
  const mod = require(MODULE_PATH);
  return {
    mod,
    restore: () => {
      delete require.cache[require.resolve(MODULE_PATH)];
      restore();
    }
  };
}

function createCodexTab(mock, uriString, options = {}) {
  return {
    isActive: Boolean(options.isActive),
    input: {
      viewType: 'chatgpt.conversationEditor',
      uri: mock.vscode.Uri.parse(uriString)
    }
  };
}

function createLogger() {
  const entries = [];
  return {
    entries,
    info: (message, data) => entries.push({ level: 'info', message, data }),
    warn: (message, data) => entries.push({ level: 'warn', message, data }),
    error: (message, data) => entries.push({ level: 'error', message, data })
  };
}

test('pending Codex warm-up stays fresh long enough for slow Codex startup', () => {
  const mock = createMockVscode();
  const { mod, restore } = loadWarmupModule(mock);
  try {
    const now = Date.parse('2026-05-20T10:00:00.000Z');
    assert.equal(mod.DEFAULT_COMMAND_READY_TIMEOUT_MS, 3 * 60 * 1000);
    assert.equal(
      mod.isPendingCodexPostSwitchWarmupFresh(
        { scheduledAt: now - 3 * 60 * 1000 - 5 * 1000 },
        now
      ),
      true
    );
    assert.equal(
      mod.isPendingCodexPostSwitchWarmupFresh(
        { scheduledAt: now - mod.DEFAULT_PENDING_WARMUP_MAX_AGE_MS - 1 },
        now
      ),
      false
    );
  } finally {
    restore();
  }
});

test('captures the active Codex conversation editor tab before account switch', () => {
  const mock = createMockVscode();
  const inactiveUri = 'openai-codex://route/local/thread-inactive';
  const activeUri = 'openai-codex://route/local/thread-active';
  const inactiveTab = createCodexTab(mock, inactiveUri);
  const activeTab = createCodexTab(mock, activeUri, { isActive: true });
  const activeGroup = {
    viewColumn: 2,
    activeTab,
    tabs: [inactiveTab, activeTab]
  };
  mock.setTabGroups([activeGroup], activeGroup);

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const context = mod.captureCurrentCodexChatContext(createLogger(), {
      fallbackToSidebar: true
    });

    assert.equal(context.kind, 'conversationEditor');
    assert.equal(context.uri, activeUri);
    assert.equal(context.viewColumn, 2);
    assert.equal(context.source, 'active-codex-tab');
  } finally {
    restore();
  }
});

test('restores a Codex conversation editor and does not create a new chat', async () => {
  const mock = createMockVscode({
    commands: ['chatgpt.openSidebar', 'chatgpt.newChat', 'vscode.openWith']
  });
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    activate: async () => {}
  });
  const uri = 'openai-codex://route/local/thread-restore';
  const staleTab = createCodexTab(mock, uri, { isActive: true });
  const group = {
    viewColumn: 1,
    activeTab: staleTab,
    tabs: [staleTab]
  };
  mock.setTabGroups([group], group);

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const restored = await mod.warmUpCodexAfterProfileSwitch(
      'unit-test',
      createLogger(),
      {
        restoreChatContext: {
          kind: 'conversationEditor',
          uri,
          viewColumn: 1,
          source: 'unit-test'
        },
        showErrorMessage: false,
        commandReadyTimeoutMs: 50,
        commandTimeoutMs: 50,
        pollIntervalMs: 1
      }
    );

    assert.equal(restored, true);
    assert.equal(mock.closedTabs.length, 1);
    assert.equal(mock.closedTabs[0].tabs[0], staleTab);
    assert.equal(mock.closedTabs[0].preserveFocus, true);
    assert.deepEqual(
      mock.commandCalls.map((call) => call.command),
      ['vscode.openWith']
    );
    assert.equal(mock.commandCalls.some((call) => call.command === 'chatgpt.newChat'), false);
    assert.equal(mock.commandCalls.some((call) => call.command === 'chatgpt.openSidebar'), false);
    assert.equal(mock.commandCalls[0].args[1], 'chatgpt.conversationEditor');
    assert.equal(mock.commandCalls[0].args[2].preview, false);
  } finally {
    restore();
  }
});

test('does not open built-in or Codex chat when official Codex commands are not ready', async () => {
  const mock = createMockVscode({
    commands: ['vscode.openWith']
  });
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    activate: async () => {}
  });

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const restored = await mod.warmUpCodexAfterProfileSwitch(
      'commands-missing',
      createLogger(),
      {
        restoreChatContext: { kind: 'sidebar', source: 'unit-test' },
        showErrorMessage: false,
        commandReadyTimeoutMs: 5,
        commandTimeoutMs: 50,
        pollIntervalMs: 1
      }
    );

    assert.equal(restored, false);
    assert.deepEqual(mock.commandCalls, []);
  } finally {
    restore();
  }
});
