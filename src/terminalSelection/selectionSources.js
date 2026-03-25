'use strict';

const vscode = require('vscode');

const TERMINAL_FOCUS_COMMAND = 'workbench.action.terminal.focus';
const TERMINAL_SELECTION_RETRY_DELAYS_MS = [50, 120, 220];
const TERMINAL_SELECTION_CACHE_MAX_AGE_MS = 2500;
const recentTerminalSelections = new WeakMap();
let terminalSelectionCacheSuppressionDepth = 0;

async function readClipboardSelectionText() {
  const text = await vscode.env.clipboard.readText();

  if (!text.trim()) {
    throw new Error('Clipboard is empty. Copy text from the terminal and try again.');
  }

  return text;
}

function peekTerminalSelectionText(terminal) {
  const selection = getTerminalSelectionText(terminal);
  if (selection.trim() && !isTerminalSelectionCacheSuppressed()) {
    rememberTerminalSelectionText(terminal, selection);
  }

  return selection;
}

async function readTerminalSelectionText(terminal, options = {}) {
  const immediateSelection = peekTerminalSelectionText(terminal);
  if (immediateSelection.trim()) {
    return immediateSelection;
  }

  if (options.refocusTerminal !== false) {
    await refocusTerminalForSelectionRead(terminal);

    for (const delayMs of TERMINAL_SELECTION_RETRY_DELAYS_MS) {
      await delay(delayMs);

      const retriedSelection = peekTerminalSelectionText(terminal);
      if (retriedSelection.trim()) {
        return retriedSelection;
      }
    }
  }

  const cachedSelection =
    options.allowRecentSelectionCache === false
      ? ''
      : getRecentTerminalSelectionText(
          terminal,
          Number.isFinite(options.recentSelectionMaxAgeMs)
            ? Math.max(0, options.recentSelectionMaxAgeMs)
            : TERMINAL_SELECTION_CACHE_MAX_AGE_MS
        );

  if (!cachedSelection.trim()) {
    throw new Error(
      'No terminal selection is available. Select text in the active terminal or switch to the clipboard strategy.'
    );
  }

  return cachedSelection;
}

function rememberTerminalSelectionText(terminal, selectionText) {
  const selection = String(selectionText || '');
  if (!terminal || !selection.trim()) {
    return selection;
  }

  recentTerminalSelections.set(terminal, {
    selection,
    updatedAt: Date.now()
  });
  return selection;
}

function getRecentTerminalSelectionText(
  terminal,
  maxAgeMs = TERMINAL_SELECTION_CACHE_MAX_AGE_MS
) {
  if (!terminal) {
    return '';
  }

  const entry = recentTerminalSelections.get(terminal);
  if (!entry || !entry.selection || !entry.selection.trim()) {
    return '';
  }

  if (Date.now() - entry.updatedAt > maxAgeMs) {
    return '';
  }

  return entry.selection;
}

function getTerminalSelectionText(terminal) {
  return terminal && typeof terminal.selection === 'string' ? terminal.selection : '';
}

function isTerminalSelectionCacheSuppressed() {
  return terminalSelectionCacheSuppressionDepth > 0;
}

async function runWithTerminalSelectionCacheSuppressed(work) {
  terminalSelectionCacheSuppressionDepth += 1;
  try {
    return await work();
  } finally {
    terminalSelectionCacheSuppressionDepth = Math.max(
      0,
      terminalSelectionCacheSuppressionDepth - 1
    );
  }
}

async function refocusTerminalForSelectionRead(terminal) {
  if (!terminal) {
    return;
  }

  try {
    if (typeof terminal.show === 'function') {
      terminal.show(false);
    }
  } catch {
    // Best-effort only: selection can still be restored from the recent cache.
  }

  await delay(30);

  try {
    await vscode.commands.executeCommand(TERMINAL_FOCUS_COMMAND);
  } catch {
    // Best-effort only: the selection may still become available on a later retry.
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

module.exports = {
  readClipboardSelectionText,
  readTerminalSelectionText,
  peekTerminalSelectionText,
  rememberTerminalSelectionText,
  getRecentTerminalSelectionText,
  runWithTerminalSelectionCacheSuppressed
};
