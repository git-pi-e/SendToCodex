'use strict';

const vscode = require('vscode');

class EditorSelectionCodexSender {
  constructor(codexCommandClient, output, logger) {
    this.codexCommandClient = codexCommandClient;
    this.output = output;
    this.logger = logger;
  }

  async sendActiveEditorSelectionToCodexChat() {
    try {
      this.logger && this.logger.info('Attempting to send active editor selection to Codex.');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        throw new Error('No active editor found.');
      }

      if (editor.document.uri.scheme !== 'file') {
        throw new Error('The active editor must point to a file to send its selection to Codex.');
      }

      if (editor.selection.isEmpty) {
        throw new Error('No editor selection is available.');
      }

      const usedCommand = await this.codexCommandClient.attachEditorSelectionOrFile(
        editor.document.uri
      );

      this.logger &&
        this.logger.info('Active editor selection sent to Codex.', {
          command: usedCommand,
          filePath: editor.document.uri.fsPath
        });
      this.output.appendLine(`Sent active editor selection to Codex using ${usedCommand}.`);
      void vscode.window.showInformationMessage('Sent editor selection to Codex Chat.');
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.logger &&
        this.logger.error('Failed to send active editor selection to Codex.', {
          error: message
        });
      this.output.appendLine(message);
      void vscode.window.showWarningMessage(message);
    }
  }
}

module.exports = {
  EditorSelectionCodexSender
};
