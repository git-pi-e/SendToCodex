'use strict';

const { resolveSelectionInTextLog } = require('../selectionSearch');
const { readClipboardSelectionText } = require('../selectionSources');

const strategyDefinition = {
  id: 'clipboardTextSearch',
  label: 'Clipboard Text Search',
  description:
    'Reads copied terminal text from the clipboard and searches for its last occurrence in the plain-text terminal log.'
};

async function resolve(context) {
  const selectionText = await readClipboardSelectionText();

  const result = await resolveSelectionInTextLog({
    filePath: context.terminalState.paths.textLogPath,
    selectionText,
    contextLines: context.configuration.selectionContextLines,
    strategyLabel: strategyDefinition.label,
    selectionSourceLabel: 'clipboard text'
  });

  return {
    ...result,
    selectionText
  };
}

module.exports = {
  resolve,
  strategyDefinition
};
