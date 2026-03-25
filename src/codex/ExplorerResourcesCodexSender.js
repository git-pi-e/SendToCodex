'use strict';

const path = require('path');
const vscode = require('vscode');
const { normalizeExplorerSelection } = require('../explorer/normalizeExplorerSelection');

class ExplorerResourcesCodexSender {
  constructor(codexCommandClient, output, logger) {
    this.codexCommandClient = codexCommandClient;
    this.output = output;
    this.logger = logger;
  }

  async sendExplorerResourcesToCodexChat(resource, selection) {
    const targets = normalizeExplorerSelection(resource, selection);
    if (targets.length === 0) {
      void vscode.window.showWarningMessage('No file or folder was selected.');
      return;
    }

    try {
      this.logger &&
        this.logger.info('Attempting to send Explorer resources to Codex.', {
          targetCount: targets.length
        });

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            targets.length === 1
              ? 'Adding path to Codex Chat'
              : `Adding ${targets.length} paths to Codex Chat`,
          cancellable: false
        },
        async (progress) => {
          for (let index = 0; index < targets.length; index += 1) {
            const target = targets[index];
            progress.report({
              increment: 100 / targets.length,
              message: `${index + 1}/${targets.length}: ${path.basename(target.fsPath)}`
            });

            await this.codexCommandClient.attachFileOrFolder(target);
          }
        }
      );

      const summary =
        targets.length === 1
          ? 'Added 1 path to Codex Chat.'
          : `Added ${targets.length} paths to Codex Chat.`;

      this.logger &&
        this.logger.info('Explorer resources sent to Codex.', {
          targetCount: targets.length,
          targets: targets.map((target) => target.fsPath)
        });
      this.output.appendLine(summary);
      vscode.window.setStatusBarMessage(summary, 5000);
      if (targets.length > 1) {
        void vscode.window.showInformationMessage(summary);
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.logger &&
        this.logger.error('Failed to send Explorer resources to Codex.', {
          error: message
        });
      this.output.appendLine(message);
      void vscode.window.showWarningMessage(message);
    }
  }
}

module.exports = {
  ExplorerResourcesCodexSender
};
