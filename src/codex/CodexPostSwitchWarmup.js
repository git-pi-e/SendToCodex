'use strict';

const vscode = require('vscode');

const CODEX_EXTENSION_ID = 'openai.chatgpt';
const CODEX_OPEN_SIDEBAR_COMMAND = 'chatgpt.openSidebar';
const CODEX_NEW_CHAT_COMMAND = 'chatgpt.newChat';
const CODEX_CONVERSATION_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';
const CODEX_URI_SCHEME = 'openai-codex';
const CODEX_URI_AUTHORITY = 'route';

const DEFAULT_ACTIVATION_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_COMMAND_READY_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_PENDING_WARMUP_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_POST_SWITCH_WARMUP_DELAY_MS = 15 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function withTimeout(promise, timeoutMs, description) {
  const ms = Math.max(0, Number(timeoutMs) || 0);
  if (!ms) {
    return Promise.resolve(promise);
  }

  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${description} timed out after ${ms}ms.`));
      }, ms);
    })
  ]);
}

function asUriString(uri) {
  if (!uri) {
    return null;
  }

  if (typeof uri === 'string') {
    return uri;
  }

  if (typeof uri.toString === 'function') {
    return uri.toString();
  }

  return null;
}

function isCodexConversationUri(uri) {
  return Boolean(
    uri &&
      uri.scheme === CODEX_URI_SCHEME &&
      (!uri.authority || uri.authority === CODEX_URI_AUTHORITY)
  );
}

function isCodexConversationTab(tab) {
  const input = tab && tab.input;
  return Boolean(
    input &&
      input.viewType === CODEX_CONVERSATION_EDITOR_VIEW_TYPE &&
      isCodexConversationUri(input.uri)
  );
}

function getTabUriString(tab) {
  return asUriString(tab && tab.input && tab.input.uri);
}

function getGroupViewColumn(group) {
  const viewColumn = Number(group && group.viewColumn);
  return Number.isFinite(viewColumn) && viewColumn > 0 ? viewColumn : undefined;
}

function createSidebarContext(source = 'fallback') {
  return {
    kind: 'sidebar',
    source
  };
}

function createConversationContext(tab, group, source) {
  return {
    kind: 'conversationEditor',
    source,
    uri: getTabUriString(tab),
    viewType: CODEX_CONVERSATION_EDITOR_VIEW_TYPE,
    viewColumn: getGroupViewColumn(group)
  };
}

function isRestorableCodexChatContext(context) {
  if (!context || typeof context !== 'object') {
    return false;
  }

  if (context.kind === 'sidebar') {
    return true;
  }

  return Boolean(context.kind === 'conversationEditor' && context.uri);
}

function captureCurrentCodexChatContext(logger, options = {}) {
  const groups = vscode.window.tabGroups && Array.isArray(vscode.window.tabGroups.all)
    ? vscode.window.tabGroups.all
    : [];
  const activeGroup = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup;

  const candidates = [];
  for (const group of groups) {
    const tabs = Array.isArray(group && group.tabs) ? group.tabs : [];
    for (const tab of tabs) {
      if (!isCodexConversationTab(tab)) {
        continue;
      }

      const isActiveGroup = Boolean(activeGroup && activeGroup === group);
      const isActiveTab = Boolean(
        tab.isActive || (group && group.activeTab && group.activeTab === tab)
      );
      candidates.push({
        tab,
        group,
        rank: isActiveGroup && isActiveTab ? 0 : isActiveTab ? 1 : isActiveGroup ? 2 : 3
      });
    }
  }

  candidates.sort((left, right) => left.rank - right.rank);
  const selected = candidates[0];
  if (selected) {
    const context = createConversationContext(
      selected.tab,
      selected.group,
      selected.rank === 0 ? 'active-codex-tab' : 'visible-codex-tab'
    );
    logger &&
      logger.info &&
      logger.info('Captured Codex chat context for post-switch restore.', {
        kind: context.kind,
        source: context.source,
        uri: context.uri,
        viewColumn: context.viewColumn || null
      });
    return context;
  }

  if (options.fallbackToSidebar) {
    logger &&
      logger.info &&
      logger.info('No Codex conversation editor tab found; falling back to Codex sidebar.');
    return createSidebarContext('no-conversation-tab');
  }

  logger &&
    logger.info &&
    logger.info('No restorable Codex chat tab is currently visible.');
  return null;
}

function getCodexConversationTabsForUri(uriString) {
  const groups = vscode.window.tabGroups && Array.isArray(vscode.window.tabGroups.all)
    ? vscode.window.tabGroups.all
    : [];
  const tabs = [];
  for (const group of groups) {
    for (const tab of Array.isArray(group && group.tabs) ? group.tabs : []) {
      if (isCodexConversationTab(tab) && getTabUriString(tab) === uriString) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

async function closeCodexConversationTabs(uriString, logger) {
  const tabs = getCodexConversationTabsForUri(uriString);
  if (!tabs.length) {
    return 0;
  }

  await vscode.window.tabGroups.close(tabs, true);
  logger &&
    logger.info &&
    logger.info('Closed stale Codex conversation tabs before restore.', {
      uri: uriString,
      count: tabs.length
    });
  return tabs.length;
}

async function activateCodexExtension(logger, options = {}) {
  const extension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
  if (!extension) {
    throw new Error(`Codex extension ${CODEX_EXTENSION_ID} is not installed.`);
  }

  if (extension.isActive) {
    return extension;
  }

  logger &&
    logger.info &&
    logger.info('Activating Codex extension before post-switch warm-up.', {
      extensionId: CODEX_EXTENSION_ID
    });
  await withTimeout(
    extension.activate(),
    options.activationTimeoutMs || DEFAULT_ACTIVATION_TIMEOUT_MS,
    'Codex extension activation'
  );
  logger &&
    logger.info &&
    logger.info('Codex extension activated before post-switch warm-up.', {
      extensionId: CODEX_EXTENSION_ID
    });
  return extension;
}

async function waitForCodexCommands(logger, options = {}) {
  const timeoutMs = Math.max(
    0,
    Number(options.commandReadyTimeoutMs || DEFAULT_COMMAND_READY_TIMEOUT_MS)
  );
  const pollIntervalMs = Math.max(
    100,
    Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS)
  );
  const startedAt = Date.now();
  let lastCommands = [];

  while (Date.now() - startedAt <= timeoutMs) {
    const commands = await vscode.commands.getCommands(true);
    lastCommands = commands;
    const hasOpenSidebar = commands.includes(CODEX_OPEN_SIDEBAR_COMMAND);
    const hasNewChat = commands.includes(CODEX_NEW_CHAT_COMMAND);
    if (hasOpenSidebar && hasNewChat) {
      logger &&
        logger.info &&
        logger.info('Codex commands are ready after profile switch.', {
          waitedMs: Date.now() - startedAt
        });
      return {
        waitedMs: Date.now() - startedAt,
        commands
      };
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Codex commands were not ready after ${timeoutMs}ms. Missing: ${[
      lastCommands.includes(CODEX_OPEN_SIDEBAR_COMMAND) ? null : CODEX_OPEN_SIDEBAR_COMMAND,
      lastCommands.includes(CODEX_NEW_CHAT_COMMAND) ? null : CODEX_NEW_CHAT_COMMAND
    ]
      .filter(Boolean)
      .join(', ')}`
  );
}

async function executeCodexCommand(command, args, logger, options = {}) {
  logger &&
    logger.info &&
    logger.info('Executing Codex command after profile switch.', { command });
  return withTimeout(
    vscode.commands.executeCommand(command, ...(Array.isArray(args) ? args : [])),
    options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    `Codex command ${command}`
  );
}

async function restoreCodexConversationEditor(context, logger, options = {}) {
  const uri = vscode.Uri.parse(context.uri);
  if (!isCodexConversationUri(uri)) {
    throw new Error(`Refusing to restore non-Codex URI: ${context.uri}`);
  }

  await closeCodexConversationTabs(context.uri, logger);
  const viewColumn = context.viewColumn || vscode.ViewColumn.Active;
  await executeCodexCommand(
    'vscode.openWith',
    [
      uri,
      CODEX_CONVERSATION_EDITOR_VIEW_TYPE,
      {
        preview: false,
        preserveFocus: false,
        viewColumn
      }
    ],
    logger,
    options
  );
  logger &&
    logger.info &&
    logger.info('Restored Codex conversation editor after profile switch.', {
      uri: context.uri,
      viewColumn
    });
}

async function openCodexSidebar(logger, options = {}) {
  await executeCodexCommand(CODEX_OPEN_SIDEBAR_COMMAND, [], logger, options);
  logger &&
    logger.info &&
    logger.info('Opened Codex sidebar after profile switch.');
}

async function warmUpCodexAfterProfileSwitch(reason, logger, options = {}) {
  const restoreChatContext = isRestorableCodexChatContext(options.restoreChatContext)
    ? options.restoreChatContext
    : createSidebarContext('default');

  try {
    await activateCodexExtension(logger, options);
    await waitForCodexCommands(logger, options);

    if (restoreChatContext.kind === 'conversationEditor') {
      await restoreCodexConversationEditor(restoreChatContext, logger, options);
    } else {
      await openCodexSidebar(logger, options);
    }

    logger &&
      logger.info &&
      logger.info('Warmed up Codex after profile switch.', {
        reason,
        restoredKind: restoreChatContext.kind,
        restoredSource: restoreChatContext.source || null
      });
    return true;
  } catch (error) {
    const message = getErrorMessage(error);
    logger &&
      logger.error &&
      logger.error('Failed to warm up Codex after profile switch.', {
        reason,
        restoredKind: restoreChatContext.kind,
        restoredSource: restoreChatContext.source || null,
        error: message
      });
    if (options.showErrorMessage !== false && vscode.window && vscode.window.showWarningMessage) {
      void vscode.window.showWarningMessage(
        `Codex chat did not reopen after account switch: ${message}`
      );
    }
    return false;
  }
}

function isPendingCodexPostSwitchWarmupFresh(pending, now = Date.now(), maxAgeMs = DEFAULT_PENDING_WARMUP_MAX_AGE_MS) {
  return Boolean(
    pending &&
      pending.scheduledAt &&
      now - Number(pending.scheduledAt) <= Math.max(0, Number(maxAgeMs) || 0)
  );
}

module.exports = {
  CODEX_CONVERSATION_EDITOR_VIEW_TYPE,
  CODEX_EXTENSION_ID,
  CODEX_NEW_CHAT_COMMAND,
  CODEX_OPEN_SIDEBAR_COMMAND,
  CODEX_URI_AUTHORITY,
  CODEX_URI_SCHEME,
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  DEFAULT_COMMAND_READY_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_PENDING_WARMUP_MAX_AGE_MS,
  DEFAULT_POST_SWITCH_WARMUP_DELAY_MS,
  captureCurrentCodexChatContext,
  closeCodexConversationTabs,
  isPendingCodexPostSwitchWarmupFresh,
  isRestorableCodexChatContext,
  warmUpCodexAfterProfileSwitch,
  waitForCodexCommands,
  withTimeout
};
