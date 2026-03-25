'use strict';

const { resolveSelectionInTextLog } = require('../selectionSearch');
const { readTerminalSelectionText } = require('../selectionSources');

const strategyDefinition = {
  id: 'terminalSelectionTextSearch',
  label: 'Terminal Selection Text Search',
  description:
    'Reads the active terminal selection and searches for its last occurrence in the plain-text terminal log.'
};

async function resolve(context) {
  const selectionText = await readTerminalSelectionText(context.terminal);

  const result = await resolveSelectionInTextLog({
    filePath: context.terminalState.paths.textLogPath,
    selectionText,
    contextLines: context.configuration.selectionContextLines,
    strategyLabel: strategyDefinition.label,
    selectionSourceLabel: 'terminal selection'
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
