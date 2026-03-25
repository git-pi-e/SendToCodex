'use strict';

const fs = require('fs');
const path = require('path');

async function ensureDirectory(directoryPath) {
  await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function ensureDirectoryForFile(filePath) {
  await ensureDirectory(path.dirname(filePath));
}

async function readTextFileIfExists(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

async function writeTextFile(filePath, contents) {
  await ensureDirectoryForFile(filePath);
  await fs.promises.writeFile(filePath, contents, 'utf8');
}

async function appendTextFile(filePath, contents) {
  await ensureDirectoryForFile(filePath);
  await fs.promises.appendFile(filePath, contents, 'utf8');
}

async function deleteFileIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

async function listFilePaths(directoryPath) {
  try {
    const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(directoryPath, entry.name));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

module.exports = {
  appendTextFile,
  deleteFileIfExists,
  ensureDirectory,
  ensureDirectoryForFile,
  listFilePaths,
  readTextFileIfExists,
  writeTextFile
};
