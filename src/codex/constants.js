'use strict';

const SEND_TO_CODEX_COMMAND = 'codexTerminalRecorder.sendActiveTerminalSelectionToCodexChat';
const SEND_EDITOR_TO_CODEX_COMMAND =
  'codexTerminalRecorder.sendActiveEditorSelectionToCodexChat';
const CODEX_ADD_SELECTION_COMMAND = 'chatgpt.addToThread';
const CODEX_ADD_FILE_COMMAND = 'chatgpt.addFileToThread';
const SEND_TO_CODEX_SHORTCUT_LABEL =
  process.platform === 'darwin' ? 'Cmd+Shift+L' : 'Ctrl+Shift+L';

module.exports = {
  CODEX_ADD_FILE_COMMAND,
  CODEX_ADD_SELECTION_COMMAND,
  SEND_EDITOR_TO_CODEX_COMMAND,
  SEND_TO_CODEX_COMMAND,
  SEND_TO_CODEX_SHORTCUT_LABEL
};
