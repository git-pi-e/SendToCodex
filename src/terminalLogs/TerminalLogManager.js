'use strict';

const vscode = require('vscode');
const { loadConfiguration, TERMINAL_CAPTURE_API_HINT } = require('../config');
const {
  ensureDirectory,
  readTextFileIfExists,
  writeTextFile
} = require('../files/fileSystem');
const { TerminalLogCleaner } = require('./TerminalLogCleaner');
const {
  buildSelectionSnapshotPath,
  buildTerminalLogPaths,
  resolveLogDirectory
} = require('./logPaths');
const { TerminalCommandSnapshotter } = require('./TerminalCommandSnapshotter');
const { TerminalLogSink } = require('./TerminalLogSink');
const {
  createCaptureHealth,
  describeCaptureHealth,
  hasCapturedData,
  markCapturedChunk,
  markShellExecutionStart,
  markShellIntegrationActive
} = require('./captureHealth');
const { formatMegabytes } = require('./textBuffer');

class TerminalLogManager {
  constructor(context, output, logger) {
    this.context = context;
    this.output = output;
    this.logger = logger;
    this.terminalStates = new Map();
    this.runtimeDisposables = [];
    this.nextTerminalNumber = 1;
    this.configuration = loadConfiguration();
    this.logDirectory = '';
    this.cleaner = new TerminalLogCleaner(output);
    this.commandSnapshotter = new TerminalCommandSnapshotter(output, logger);
    this.terminalWriteApiAvailable = false;
    this.shellExecutionApiAvailable = false;
    this.onDidChangeCapturedTerminalCountEmitter = new vscode.EventEmitter();
    this.onDidChangeCapturedTerminalCount = this.onDidChangeCapturedTerminalCountEmitter.event;
  }

  async activate() {
    const onDidChangeTerminalShellIntegration = getWindowEvent(
      'onDidChangeTerminalShellIntegration'
    );
    const onDidWriteTerminalData = getWindowEvent('onDidWriteTerminalData');
    const onDidStartTerminalShellExecution = getWindowEvent('onDidStartTerminalShellExecution');
    let terminalWriteApiAvailable = false;
    let shellExecutionApiAvailable = false;

    this.logger &&
      this.logger.info('Activating terminal log manager.', {
        vscodeVersion: vscode.version,
        terminalCount: vscode.window.terminals.length
      });
    this.runtimeDisposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        if (this.configuration.enabled) {
          void this.ensureState(terminal);
        }
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        void this.closeTerminal(terminal);
      })
    );

    if (onDidChangeTerminalShellIntegration) {
      try {
        this.runtimeDisposables.push(
          onDidChangeTerminalShellIntegration((event) => {
            this.handleTerminalShellIntegrationChange(event);
          })
        );
      } catch (error) {
        this.logger &&
          this.logger.warn('Terminal shell integration event is unavailable.', {
            error: error && error.message ? error.message : String(error)
          });
      }
    }

    if (onDidWriteTerminalData) {
      try {
        this.runtimeDisposables.push(
          onDidWriteTerminalData((event) => {
            if (!this.configuration.enabled) {
              return;
            }

            this.handleTerminalDataWrite(event.terminal, event.data);
          })
        );
        terminalWriteApiAvailable = true;
      } catch (error) {
        this.logger &&
          this.logger.warn('Terminal write API subscription failed.', {
            error: error && error.message ? error.message : String(error)
          });
      }
    }

    if (onDidStartTerminalShellExecution) {
      try {
        this.runtimeDisposables.push(
          onDidStartTerminalShellExecution((event) => {
            if (!this.configuration.enabled) {
              return;
            }

            void this.handleShellExecutionStart(event);
          })
        );
        shellExecutionApiAvailable = true;
      } catch (error) {
        this.logger &&
          this.logger.warn('Terminal shell execution API subscription failed.', {
            error: error && error.message ? error.message : String(error)
          });
      }
    }

    this.terminalWriteApiAvailable = terminalWriteApiAvailable;
    this.shellExecutionApiAvailable = shellExecutionApiAvailable;

    this.logger &&
      this.logger.info('Terminal capture API availability resolved.', {
        shellExecutionApiAvailable,
        terminalWriteApiAvailable
      });

    await this.reloadConfiguration(false);

    if (!terminalWriteApiAvailable && !shellExecutionApiAvailable) {
      this.logger &&
        this.logger.warn('No terminal capture APIs are available.', {
          shellExecutionApiAvailable: false,
          terminalWriteApiAvailable: false
        });
      this.output.appendLine(TERMINAL_CAPTURE_API_HINT);
      void vscode.window.showWarningMessage(TERMINAL_CAPTURE_API_HINT);
    }
  }

  async reloadConfiguration(notify) {
    const previousLogDirectory = this.logDirectory;
    const isFirstLoad = !previousLogDirectory;

    this.configuration = loadConfiguration();
    this.logDirectory = resolveLogDirectory(this.context, this.configuration.logDirectory);
    this.logger &&
      this.logger.info('Reloading terminal recorder configuration.', {
        enabled: this.configuration.enabled,
        logDirectory: this.logDirectory,
        maxBytes: this.configuration.maxBytes
      });
    await ensureDirectory(this.logDirectory);

    if (isFirstLoad) {
      await this.cleaner.cleanupDeadLogFiles(this.logDirectory, new Set());
    }

    if (this.configuration.enabled) {
      for (const terminal of vscode.window.terminals) {
        await this.ensureState(terminal);
      }
    }

    const activeFilePaths = new Set();

    for (const [terminal, state] of this.terminalStates) {
      state.selectionAttachmentPaths = state.selectionAttachmentPaths || new Set();
      state.selectionSnapshotPaths = state.selectionSnapshotPaths || new Set();
      state.nextSelectionAttachmentNumber = Math.max(
        1,
        Number(state.nextSelectionAttachmentNumber) || 1
      );
      state.nextSelectionSnapshotNumber = Math.max(
        1,
        Number(state.nextSelectionSnapshotNumber) || 1
      );
      const nextPaths = buildTerminalLogPaths(this.logDirectory, state.number, terminal.name);
      const selectionPrefixChanged =
        !state.paths ||
        state.paths.selectionFilePrefix !== nextPaths.selectionFilePrefix ||
        state.paths.snapshotFilePrefix !== nextPaths.snapshotFilePrefix;
      await state.sink.rebind(nextPaths, this.configuration.maxBytes);
      state.paths = nextPaths;
      if (selectionPrefixChanged) {
        state.selectionAttachmentPaths.clear();
        state.selectionSnapshotPaths.clear();
        state.lastSelectionSnapshotPath = '';
      }

      for (const filePath of nextPaths.allFilePaths) {
        activeFilePaths.add(filePath);
      }

      for (const filePath of state.selectionAttachmentPaths) {
        activeFilePaths.add(filePath);
      }

      for (const filePath of state.selectionSnapshotPaths) {
        activeFilePaths.add(filePath);
      }
    }

    await this.cleaner.cleanupDeadLogFiles(this.logDirectory, activeFilePaths);

    if (previousLogDirectory && previousLogDirectory !== this.logDirectory) {
      await this.cleaner.cleanupDeadLogFiles(previousLogDirectory, new Set());
    }

    if (notify) {
      const status = this.configuration.enabled ? 'enabled' : 'disabled';
      vscode.window.setStatusBarMessage(
        `Send to Codex ${status}, ${formatMegabytes(this.configuration.maxBytes)} MB per terminal`,
        3000
      );
    }
  }

  async openLogDirectory() {
    await ensureDirectory(this.logDirectory);
    const uri = vscode.Uri.file(this.logDirectory);
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  async openActiveTerminalLog() {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      void vscode.window.showInformationMessage('No active terminal found.');
      return;
    }

    const state = await this.ensureState(terminal);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(state.paths.textLogPath));
    await vscode.window.showTextDocument(document, { preview: false });

    if (!hasCapturedData(state.captureHealth)) {
      const message = formatStateCaptureSummary(state);
      this.output.appendLine(message);
      void vscode.window.showInformationMessage(message);
    }
  }

  async ensureState(terminal) {
    const existing = this.terminalStates.get(terminal);
    if (existing) {
      return existing;
    }

    const state = this.createStateSync(terminal);
    await state.sink.initialize();
    return state;
  }

  ensureStateSync(terminal) {
    const existing = this.terminalStates.get(terminal);
    if (existing) {
      return existing;
    }

    const state = this.createStateSync(terminal);
    void state.sink.initialize();
    return state;
  }

  async closeTerminal(terminal) {
    const state = this.terminalStates.get(terminal);
    if (!state) {
      return;
    }

    this.terminalStates.delete(terminal);
    this.emitCapturedTerminalCountChanged();
    await state.sink.dispose();
    const selectionAttachmentPaths = state.selectionAttachmentPaths || new Set();
    const selectionSnapshotPaths = state.selectionSnapshotPaths || new Set();
    await this.cleaner.deleteTerminalFiles([
      ...state.paths.allFilePaths,
      ...selectionAttachmentPaths,
      ...selectionSnapshotPaths
    ]);
  }

  getCapturedTerminalCount() {
    return this.terminalStates.size;
  }

  isTerminalWriteApiAvailable() {
    return this.terminalWriteApiAvailable;
  }

  isShellExecutionApiAvailable() {
    return this.shellExecutionApiAvailable;
  }

  dispose() {
    for (const disposable of this.runtimeDisposables.splice(0)) {
      disposable.dispose();
    }

    for (const [, state] of this.terminalStates) {
      void state.sink.dispose();
    }

    this.terminalStates.clear();
    this.emitCapturedTerminalCountChanged();
    this.onDidChangeCapturedTerminalCountEmitter.dispose();
  }

  createStateSync(terminal) {
    const number = this.nextTerminalNumber++;
    const paths = buildTerminalLogPaths(this.logDirectory, number, terminal.name);
    const sink = new TerminalLogSink(paths, this.configuration.maxBytes, this.output);
    const state = {
      number,
      paths,
      sink,
      captureMode: 'unknown',
      nextSelectionAttachmentNumber: 1,
      nextSelectionSnapshotNumber: 1,
      selectionAttachmentPaths: new Set(),
      selectionSnapshotPaths: new Set(),
      lastSelectionSnapshotPath: '',
      captureHealth: createCaptureHealth({
        terminalWriteApiAvailable: this.isTerminalWriteApiAvailable(),
        shellExecutionApiAvailable: this.isShellExecutionApiAvailable(),
        shellIntegrationActive: hasTerminalShellIntegration(terminal)
      })
    };

    this.terminalStates.set(terminal, state);
    this.emitCapturedTerminalCountChanged();

    this.logger &&
      this.logger.info('Tracking terminal for capture.', {
        terminalName: terminal.name,
        baseName: state.paths.baseName,
        shellIntegrationActive: hasTerminalShellIntegration(terminal)
      });
    return state;
  }

  emitCapturedTerminalCountChanged() {
    this.onDidChangeCapturedTerminalCountEmitter.fire(this.terminalStates.size);
  }

  handleTerminalDataWrite(terminal, data) {
    const state = this.ensureStateSync(terminal);
    const hadCapturedData = hasCapturedData(state.captureHealth);
    if (state.captureMode === 'shellExecution') {
      return;
    }

    if (state.captureMode !== 'terminalDataWrite') {
      state.captureMode = 'terminalDataWrite';
      this.logger &&
        this.logger.info('Terminal capture mode selected.', {
          terminalName: terminal.name,
          mode: state.captureMode
        });
    }

    markCapturedChunk(state.captureHealth, 'terminalDataWrite', data);
    if (!hadCapturedData && hasCapturedData(state.captureHealth)) {
      this.emitCapturedTerminalCountChanged();
    }
    state.sink.append(data);
  }

  handleTerminalShellIntegrationChange(event) {
    const state = this.ensureStateSync(event.terminal);
    markShellIntegrationActive(state.captureHealth);
    this.logger &&
      this.logger.info('Terminal shell integration activated.', {
        terminalName: event.terminal.name,
        baseName: state.paths.baseName
      });
  }

  async handleShellExecutionStart(event) {
    const executionStream = event.execution.read();
    const state = this.ensureStateSync(event.terminal);
    markShellExecutionStart(state.captureHealth);
    if (state.captureMode === 'terminalDataWrite') {
      return;
    }

    this.logger &&
      this.logger.info('Started shell execution capture.', {
        terminalName: event.terminal.name,
        baseName: state.paths.baseName,
        shellIntegrationActive: Boolean(event.shellIntegration)
      });

    try {
      const shellExecutionPreamble = this.terminalWriteApiAvailable
        ? ''
        : buildShellExecutionPreamble(event);

      if (shellExecutionPreamble) {
        const hadCapturedData = hasCapturedData(state.captureHealth);
        if (state.captureMode !== 'shellExecution') {
          state.captureMode = 'shellExecution';
          this.logger &&
            this.logger.info('Terminal capture mode selected.', {
              terminalName: event.terminal.name,
              mode: state.captureMode
            });
        }

        markCapturedChunk(state.captureHealth, 'shellExecution', shellExecutionPreamble);
        if (!hadCapturedData && hasCapturedData(state.captureHealth)) {
          this.emitCapturedTerminalCountChanged();
        }
        state.sink.append(shellExecutionPreamble);
      }

      for await (const chunk of executionStream) {
        const hadCapturedData = hasCapturedData(state.captureHealth);
        if (state.captureMode === 'terminalDataWrite') {
          return;
        }

        if (state.captureMode !== 'shellExecution') {
          state.captureMode = 'shellExecution';
          this.logger &&
            this.logger.info('Terminal capture mode selected.', {
              terminalName: event.terminal.name,
              mode: state.captureMode
            });
        }

        markCapturedChunk(state.captureHealth, 'shellExecution', chunk);
        if (!hadCapturedData && hasCapturedData(state.captureHealth)) {
          this.emitCapturedTerminalCountChanged();
        }
        state.sink.append(chunk);
      }
    } catch (error) {
      this.logger &&
        this.logger.error('Shell execution capture failed.', {
          terminalName: event.terminal.name,
          error: error && error.message ? error.message : String(error)
        });
    }
  }

  getCapturedOutputTerminalCount() {
    let count = 0;

    for (const [, state] of this.terminalStates) {
      if (hasCapturedData(state.captureHealth)) {
        count += 1;
      }
    }

    return count;
  }

  async captureLastCommandSnapshot(terminal) {
    const state = await this.ensureState(terminal);
    const hadCapturedData = hasCapturedData(state.captureHealth);
    const result = await this.commandSnapshotter.captureLastCommandSnapshot(terminal, state);

    this.recordSnapshotCaptureResult(terminal, state, result, hadCapturedData);

    return result;
  }

  async captureSelectionSnapshot(terminal, options = {}) {
    const state = await this.ensureState(terminal);
    const useCurrentBufferOnly = Boolean(options.useCurrentBufferOnly);
    let snapshotResult = null;

    if (!useCurrentBufferOnly) {
      const hadCapturedData = hasCapturedData(state.captureHealth);
      snapshotResult = await this.commandSnapshotter.captureLastCommandSnapshot(terminal, state);
      this.recordSnapshotCaptureResult(terminal, state, snapshotResult, hadCapturedData);
    }

    const snapshotText = normalizeSnapshotText(
      (snapshotResult && snapshotResult.text) ||
        state.sink.textBuffer ||
        (await readTextFileIfExists(state.paths.textLogPath))
    );
    const previousSnapshotPath = state.lastSelectionSnapshotPath || '';

    if (previousSnapshotPath) {
      const previousSnapshotText = await readTextFileIfExists(previousSnapshotPath);
      if (previousSnapshotText === snapshotText) {
        return {
          captured: Boolean(snapshotResult && snapshotResult.captured),
          filePath: previousSnapshotPath,
          reusedExistingSnapshot: true,
          text: snapshotText
        };
      }
    }

    const snapshotPath = buildSelectionSnapshotPath(
      state.paths,
      state.nextSelectionSnapshotNumber,
      'txt'
    );
    state.nextSelectionSnapshotNumber += 1;
    state.selectionSnapshotPaths.add(snapshotPath);
    state.lastSelectionSnapshotPath = snapshotPath;
    await writeTextFile(snapshotPath, snapshotText);

    return {
      captured: Boolean(snapshotResult && snapshotResult.captured),
      filePath: snapshotPath,
      reusedExistingSnapshot: false,
      text: snapshotText
    };
  }

  recordSnapshotCaptureResult(terminal, state, result, hadCapturedData) {
    if (!result || !result.captured || !result.text) {
      return;
    }

    markCapturedChunk(state.captureHealth, 'commandSnapshot', result.text);
    if (!hadCapturedData && hasCapturedData(state.captureHealth)) {
      this.emitCapturedTerminalCountChanged();
    }
    this.logger &&
      this.logger.info('Captured terminal output via terminal snapshot.', {
        terminalName: terminal.name,
        baseName: state.paths.baseName,
        appendedLength: result.text.length,
        mode: result.mode
      });
  }
}

function formatStateCaptureSummary(state) {
  return `${describeCaptureHealth(state.captureHealth)} Log file: ${state.paths.textLogPath}`;
}

function normalizeSnapshotText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildShellExecutionPreamble(event) {
  const commandLine = normalizeCommandLine(
    event &&
      event.execution &&
      event.execution.commandLine &&
      event.execution.commandLine.value
  );
  if (!commandLine) {
    return '';
  }

  const cwd = getExecutionCwdPath(event && event.execution && event.execution.cwd);
  const promptPrefix = buildPromptPrefix(event, cwd);
  return `${promptPrefix}${commandLine}\n`;
}

function normalizeCommandLine(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function getExecutionCwdPath(cwd) {
  if (!cwd) {
    return '';
  }

  if (typeof cwd.fsPath === 'string' && cwd.fsPath.trim()) {
    return cwd.fsPath.trim();
  }

  if (typeof cwd.path === 'string' && cwd.path.trim()) {
    return cwd.path.trim();
  }

  return '';
}

function buildPromptPrefix(event, cwd) {
  if (process.platform === 'win32') {
    const promptPath = cwd || '.';
    return `PS ${promptPath}> `;
  }

  if (cwd) {
    return `${cwd}$ `;
  }

  return '$ ';
}

module.exports = {
  TerminalLogManager
};

function getWindowEvent(propertyName) {
  try {
    const candidate = vscode.window[propertyName];
    return typeof candidate === 'function' ? candidate.bind(vscode.window) : null;
  } catch {
    return null;
  }
}

function hasTerminalShellIntegration(terminal) {
  try {
    return Boolean(terminal && terminal.shellIntegration);
  } catch {
    return false;
  }
}
