'use strict';

const vscode = require('vscode');

function normalizeExplorerSelection(resource, selection) {
  const candidates = [];

  if (resource instanceof vscode.Uri) {
    candidates.push(resource);
  } else if (Array.isArray(resource)) {
    candidates.push(...resource.filter((item) => item instanceof vscode.Uri));
  }

  if (Array.isArray(selection)) {
    candidates.push(...selection.filter((item) => item instanceof vscode.Uri));
  }

  const uniqueByPath = new Map();
  for (const candidate of candidates) {
    if (candidate.scheme !== 'file') {
      continue;
    }

    uniqueByPath.set(candidate.fsPath.toLowerCase(), candidate);
  }

  return Array.from(uniqueByPath.values()).sort((left, right) =>
    left.fsPath.localeCompare(right.fsPath)
  );
}

module.exports = {
  normalizeExplorerSelection
};
