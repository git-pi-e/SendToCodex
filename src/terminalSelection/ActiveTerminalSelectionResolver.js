'use strict';

const vscode = require('vscode');
const { loadConfiguration } = require('../config');
const { getSelectionTrackingStrategy } = require('./strategies');

class ActiveTerminalSelectionResolver {
  constructor(terminalLogManager) {
    this.terminalLogManager = terminalLogManager;
  }

  async resolveActiveTerminalSelection() {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      throw new Error('No active terminal found.');
    }

    const configuration = loadConfiguration();
    const terminalState = await this.terminalLogManager.ensureState(terminal);
    await terminalState.sink.flush();

    const strategy = getSelectionTrackingStrategy(configuration.selectionTrackingStrategy);
    const result = await strategy.resolve({
      configuration,
      terminal,
      terminalState
    });

    return {
      configuration,
      result,
      strategy,
      terminal,
      terminalState
    };
  }
}

module.exports = {
  ActiveTerminalSelectionResolver
};
