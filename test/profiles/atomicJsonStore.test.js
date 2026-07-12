'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { writeJsonAtomicSync } = require('../../src/profiles/atomicJsonStore');

function runWorker(modulePath, filePath, workerId, writes) {
  const script = `
    const { mutateJsonFileSync } = require(process.argv[1]);
    const filePath = process.argv[2];
    const workerId = process.argv[3];
    const writes = Number(process.argv[4]);
    for (let index = 0; index < writes; index += 1) {
      mutateJsonFileSync(
        filePath,
        { values: [] },
        (value) => typeof value === 'string' ? JSON.parse(value) : value,
        (value) => ({ values: [...value.values, workerId + ':' + index] })
      );
    }
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, modulePath, filePath, workerId, String(writes)], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Worker ${workerId} exited with ${code}: ${stderr}`));
    });
  });
}

test('atomic JSON store preserves concurrent cross-process mutations', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-active-window-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'active-window-usages.json');
  const modulePath = require.resolve('../../src/profiles/atomicJsonStore');
  const workerCount = 4;
  const writesPerWorker = 25;

  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => {
      return runWorker(modulePath, filePath, `worker-${index}`, writesPerWorker);
    })
  );

  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.values.length, workerCount * writesPerWorker);
  assert.equal(new Set(stored.values).size, workerCount * writesPerWorker);
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
});

test('atomic JSON write replaces a longer file without leaving trailing bytes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  fs.writeFileSync(filePath, JSON.stringify({ values: Array.from({ length: 100 }, () => 'long') }));

  writeJsonAtomicSync(filePath, { values: ['short'] });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { values: ['short'] });
});
