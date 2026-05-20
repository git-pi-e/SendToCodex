'use strict';

const Module = require('module');

function createUri(value) {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.replace(/:$/, ''),
    authority: parsed.host,
    path: parsed.pathname,
    fsPath: parsed.pathname,
    toString: () => value
  };
}

function createMockVscode(options = {}) {
  const commandCalls = [];
  const warningMessages = [];
  const errorMessages = [];
  const closedTabs = [];
  const commandHandlers = new Map(Object.entries(options.commandHandlers || {}));
  const extensionsById = new Map(Object.entries(options.extensions || {}));
  let commandsList = Array.isArray(options.commands) ? options.commands.slice() : [];

  const mock = {
    version: '1.105.0',
    ViewColumn: {
      Active: -1,
      One: 1,
      Two: 2,
      Three: 3
    },
    Uri: {
      parse: createUri,
      file: (filePath) => ({
        scheme: 'file',
        authority: '',
        path: filePath,
        fsPath: filePath,
        toString: () => `file://${filePath}`
      })
    },
    commands: {
      getCommands: async () => commandsList.slice(),
      executeCommand: async (command, ...args) => {
        commandCalls.push({ command, args });
        const handler = commandHandlers.get(command);
        return handler ? handler(...args) : undefined;
      }
    },
    extensions: {
      getExtension: (id) => extensionsById.get(id),
      onDidChange: () => ({ dispose() {} })
    },
    window: {
      tabGroups: {
        all: [],
        activeTabGroup: null,
        close: async (tabs, preserveFocus) => {
          closedTabs.push({ tabs, preserveFocus });
          return true;
        }
      },
      showWarningMessage: async (message) => {
        warningMessages.push(message);
        return undefined;
      },
      showErrorMessage: async (message) => {
        errorMessages.push(message);
        return undefined;
      }
    }
  };

  Object.assign(mock, options.overrides || {});

  return {
    vscode: mock,
    commandCalls,
    warningMessages,
    errorMessages,
    closedTabs,
    setCommands(nextCommands) {
      commandsList = Array.isArray(nextCommands) ? nextCommands.slice() : [];
    },
    setExtension(id, extension) {
      extensionsById.set(id, extension);
    },
    setTabGroups(groups, activeGroup) {
      mock.window.tabGroups.all = groups;
      mock.window.tabGroups.activeTabGroup = activeGroup || groups[0] || null;
    }
  };
}

function installMockVscode(vscode) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    Module._load = originalLoad;
  };
}

module.exports = {
  createMockVscode,
  installMockVscode
};
