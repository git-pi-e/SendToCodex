'use strict';

const { readTextFileIfExists } = require('../../files/fileSystem');
const { resolveSelectionInTextLog } = require('../selectionSearch');
const { readTerminalSelectionText } = require('../selectionSources');

const strategyDefinition = {
  id: 'indexedTerminalSelectionSearch',
  label: 'Indexed Terminal Selection Search',
  description:
    'Reads the active terminal selection and resolves it in the plain-text log using the sidecar line index file.'
};

async function resolve(context) {
  const selectionText = await readTerminalSelectionText(context.terminal);
  const lineStarts = await readLineStarts(context.terminalState.paths.lineIndexPath);

  const result = await resolveSelectionInTextLog({
    filePath: context.terminalState.paths.textLogPath,
    selectionText,
    contextLines: context.configuration.selectionContextLines,
    strategyLabel: strategyDefinition.label,
    selectionSourceLabel: 'terminal selection',
    providedLineStarts: lineStarts
  });

  return {
    ...result,
    selectionText
  };
}

async function readLineStarts(filePath) {
  const fileContents = await readTextFileIfExists(filePath);
  if (!fileContents) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fileContents);
    return Array.isArray(parsed.lineStarts) ? parsed.lineStarts : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  resolve,
  strategyDefinition
};
