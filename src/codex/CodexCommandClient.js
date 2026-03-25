'use strict';

const vscode = require('vscode');
const {
  CODEX_ADD_FILE_COMMAND,
  CODEX_ADD_SELECTION_COMMAND
} = require('./constants');

const KNOWN_CODEX_EXTENSION_IDS = ['openai.chatgpt'];

class CodexCommandClient {
  constructor(logger) {
    this.logger = logger;
    this.cachedCommand = undefined;
    this.lastAvailabilityCheck = 0;
    this.availabilityTtlMs = 2000;
  }

  async isAvailable(options = {}) {
    return Boolean(await this.getPreferredAvailableCommand(options));
  }

  async attachEditorSelectionOrFile(documentUri) {
    const command = await this.getPreferredAvailableCommand({ forceRefresh: true });

    if (command === CODEX_ADD_SELECTION_COMMAND) {
      await vscode.commands.executeCommand(command);
      return command;
    }

    if (command === CODEX_ADD_FILE_COMMAND) {
      await vscode.commands.executeCommand(command, documentUri);
      return command;
    }

    throw new Error(
      'Codex commands were not found. Install or enable the OpenAI Codex extension first.'
    );
  }

  async attachEditorSelection() {
    const command = await this.getSelectionAttachmentCommand({ forceRefresh: true });
    if (command === CODEX_ADD_SELECTION_COMMAND) {
      await vscode.commands.executeCommand(command);
      return command;
    }

    throw new Error(
      'Codex editor selection command was not found. Install or enable the OpenAI Codex extension first.'
    );
  }

  async attachFileOrFolder(resourceUri) {
    const command = await this.getFileAttachmentCommand({ forceRefresh: true });
    if (!command) {
      throw new Error(
        'Codex file attachment command was not found. Install or enable the OpenAI Codex extension first.'
      );
    }

    await vscode.commands.executeCommand(command, resourceUri);
    return command;
  }

  async getPreferredAvailableCommand(options = {}) {
    const now = Date.now();

    if (
      !options.forceRefresh &&
      this.cachedCommand !== undefined &&
      now - this.lastAvailabilityCheck < this.availabilityTtlMs
    ) {
      return this.cachedCommand;
    }

    let commands = await vscode.commands.getCommands(true);
    let command = pickSupportedCommand(commands);

    if (!command) {
      await this.activateKnownCodexExtensions();
      commands = await vscode.commands.getCommands(true);
      command = pickSupportedCommand(commands);
    }

    this.cachedCommand = command;
    this.lastAvailabilityCheck = now;
    this.logger &&
      this.logger.info('Codex command availability refreshed.', {
        availableCommand: this.cachedCommand || null
      });
    return this.cachedCommand;
  }

  async activateKnownCodexExtensions() {
    for (const extensionId of KNOWN_CODEX_EXTENSION_IDS) {
      const extension = vscode.extensions.getExtension(extensionId);
      if (!extension) {
        this.logger &&
          this.logger.warn('Known Codex extension is not installed.', { extensionId });
        continue;
      }

      if (extension.isActive) {
        this.logger &&
          this.logger.info('Known Codex extension is already active.', { extensionId });
        continue;
      }

      try {
        this.logger &&
          this.logger.info('Activating known Codex extension.', { extensionId });
        await extension.activate();
        this.logger &&
          this.logger.info('Known Codex extension activated.', { extensionId });
      } catch (error) {
        this.logger &&
          this.logger.error('Failed to activate known Codex extension.', {
            extensionId,
            error: error && error.message ? error.message : String(error)
          });
      }
    }
  }

  async getFileAttachmentCommand(options = {}) {
    const now = Date.now();

    if (
      !options.forceRefresh &&
      this.cachedCommand === CODEX_ADD_FILE_COMMAND &&
      now - this.lastAvailabilityCheck < this.availabilityTtlMs
    ) {
      return this.cachedCommand;
    }

    let commands = await vscode.commands.getCommands(true);
    let hasFileCommand = commands.includes(CODEX_ADD_FILE_COMMAND);

    if (!hasFileCommand) {
      await this.activateKnownCodexExtensions();
      commands = await vscode.commands.getCommands(true);
      hasFileCommand = commands.includes(CODEX_ADD_FILE_COMMAND);
    }

    if (hasFileCommand) {
      this.cachedCommand = CODEX_ADD_FILE_COMMAND;
      this.lastAvailabilityCheck = now;
      this.logger &&
        this.logger.info('Codex file attachment command availability refreshed.', {
          availableCommand: CODEX_ADD_FILE_COMMAND
        });
      return CODEX_ADD_FILE_COMMAND;
    }

    this.logger &&
      this.logger.warn('Codex file attachment command is unavailable.', {
        command: CODEX_ADD_FILE_COMMAND
      });
    return null;
  }

  async getSelectionAttachmentCommand(options = {}) {
    const now = Date.now();

    if (
      !options.forceRefresh &&
      this.cachedCommand === CODEX_ADD_SELECTION_COMMAND &&
      now - this.lastAvailabilityCheck < this.availabilityTtlMs
    ) {
      return this.cachedCommand;
    }

    let commands = await vscode.commands.getCommands(true);
    let hasSelectionCommand = commands.includes(CODEX_ADD_SELECTION_COMMAND);

    if (!hasSelectionCommand) {
      await this.activateKnownCodexExtensions();
      commands = await vscode.commands.getCommands(true);
      hasSelectionCommand = commands.includes(CODEX_ADD_SELECTION_COMMAND);
    }

    if (hasSelectionCommand) {
      this.cachedCommand = CODEX_ADD_SELECTION_COMMAND;
      this.lastAvailabilityCheck = now;
      this.logger &&
        this.logger.info('Codex selection command availability refreshed.', {
          availableCommand: CODEX_ADD_SELECTION_COMMAND
        });
      return CODEX_ADD_SELECTION_COMMAND;
    }

    this.logger &&
      this.logger.warn('Codex selection command is unavailable.', {
        command: CODEX_ADD_SELECTION_COMMAND
      });
    return null;
  }
}

function pickSupportedCommand(commands) {
  if (commands.includes(CODEX_ADD_SELECTION_COMMAND)) {
    return CODEX_ADD_SELECTION_COMMAND;
  }

  if (commands.includes(CODEX_ADD_FILE_COMMAND)) {
    return CODEX_ADD_FILE_COMMAND;
  }

  return null;
}

module.exports = {
  CodexCommandClient
};
