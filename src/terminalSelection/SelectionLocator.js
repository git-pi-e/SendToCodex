'use strict';

const vscode = require('vscode');

class SelectionLocator {
  constructor(selectionResolver, output, popupSuppression) {
    this.selectionResolver = selectionResolver;
    this.output = output;
    this.popupSuppression = popupSuppression;
  }

  async locateActiveTerminalSelection() {
    try {
      const resolution = await this.selectionResolver.resolveActiveTerminalSelection();
      const { result, strategy } = resolution;

      if (!result.found) {
        this.output.appendLine(`[${strategy.strategyDefinition.id}] ${result.message}`);
        void vscode.window.showWarningMessage(result.message);
        return;
      }

      await this.showResolvedSelection(result);
      this.output.appendLine(`[${strategy.strategyDefinition.id}] ${result.summary}`);
      this.output.appendLine(result.preview);
      void vscode.window.showInformationMessage(result.summary);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showWarningMessage(message);
    }
  }

  async showResolvedSelection(result) {
    this.popupSuppression && this.popupSuppression.suppress(1500, 'selection-locator-open');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(result.filePath));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const start = new vscode.Position(result.range.start.line, result.range.start.character);
    const end = new vscode.Position(result.range.end.line, result.range.end.character);
    const range = new vscode.Range(start, end);

    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
}

module.exports = {
  SelectionLocator
};
