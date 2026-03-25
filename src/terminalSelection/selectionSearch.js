'use strict';

const { readTextFileIfExists } = require('../files/fileSystem');
const { buildLineStarts, buildPreview, createOffsetRange } = require('../terminalLogs/lineIndex');

async function resolveSelectionInTextLog(options) {
  const {
    filePath,
    selectionText,
    contextLines,
    strategyLabel,
    selectionSourceLabel,
    providedLineStarts
  } = options;
  const textContent = await readTextFileIfExists(filePath);

  if (!textContent) {
    return {
      found: false,
      message: 'The plain-text terminal log is empty.'
    };
  }

  const query = findSearchQuery(selectionText, textContent);
  if (!query) {
    return {
      found: false,
      message: 'The selected text was empty or could not be normalized for searching.'
    };
  }

  const startOffset = textContent.lastIndexOf(query);
  if (startOffset < 0) {
    return {
      found: false,
      message: 'The selected text was not found in the plain-text terminal log.'
    };
  }

  const lineStarts = providedLineStarts || buildLineStarts(textContent);
  const endOffset = startOffset + query.length;
  const range = createOffsetRange(lineStarts, startOffset, endOffset);
  const preview = buildPreview(textContent, lineStarts, range, contextLines);

  return {
    found: true,
    filePath,
    preview,
    query,
    range,
    summary:
      `${strategyLabel} resolved ${selectionSourceLabel} ` +
      `to line ${range.start.line + 1}, column ${range.start.character + 1}.`
  };
}

function findSearchQuery(selectionText, textContent) {
  const normalizedSelection = normalizeSearchText(selectionText);
  const candidates = uniqueNonEmpty([
    normalizedSelection,
    normalizedSelection.trimEnd(),
    normalizedSelection.trim()
  ]);

  for (const candidate of candidates) {
    if (textContent.lastIndexOf(candidate) >= 0) {
      return candidate;
    }
  }

  return candidates[0] || '';
}

function normalizeSearchText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.filter((value) => value)));
}

module.exports = {
  resolveSelectionInTextLog
};
