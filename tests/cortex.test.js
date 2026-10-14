/**
 * Test: SWEP Cortex - Observer, Habit Graph, and App Sniffer
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  detectProjectContext,
  detectProjectConfigs,
  scanActiveListeningPorts,
} from '../src/cortex/observer.js';
import {
  createDefaultCortex,
  recordWorkspaceSession,
  predictWorkspaceRequirements,
  formatCortexInsights,
  saveCortexMemory,
  loadCortexMemory,
} from '../src/cortex/habit.js';
import {
  classifyFileSemantic,
  locateAppStorageCandidates,
  inspectAppStorageFootprint,
} from '../src/cortex/sniffer.js';
import { LiveLogger } from '../src/cortex/monitor.js';

test('cortex observer: detectProjectConfigs correctly analyzes project directory', () => {
  const currentDir = process.cwd();
  const { projectName, configs, technologies } = detectProjectConfigs(currentDir);

  assert.strictEqual(projectName, '@nhatprx/swep');
  assert.ok(technologies.includes('Node.js'));
  assert.ok(configs.some((c) => c.file === 'package.json'));
});

test('cortex observer: detectProjectContext generates consistent projectId', async () => {
  const ctx = await detectProjectContext(process.cwd());
  assert.ok(ctx.projectId.startsWith('proj_'));
  assert.strictEqual(ctx.projectName, '@nhatprx/swep');
  assert.ok(Array.isArray(ctx.technologies));
});

test('cortex observer: scanActiveListeningPorts returns an array of ports', async () => {
  const ports = await scanActiveListeningPorts();
  assert.ok(Array.isArray(ports));
  for (const p of ports) {
    assert.strictEqual(typeof p.port, 'number');
    assert.strictEqual(typeof p.processName, 'string');
  }
});

test('cortex habit: record sessions and predict requirements accurately', () => {
  const cortex = createDefaultCortex();

  const mockSnapshot = {
    project: {
      projectId: 'proj_test123',
      projectName: 'my-service',
      projectDir: 'C:\\test',
      gitRemote: 'https://github.com/test/my-service',
      technologies: ['Node.js', 'Docker'],
    },
    devPorts: [
      { port: 3306, serviceInfo: { service: 'MySQL' } },
      { port: 5173, serviceInfo: { service: 'Vite Dev Server' } },
    ],
    browserTabs: [
      { title: 'Localhost', url: 'http://localhost:5173/dashboard' },
      { title: 'GitHub PR', url: 'https://github.com/test/my-service/pull/42' },
    ],
  };

  // Record 3 sessions
  recordWorkspaceSession(cortex, mockSnapshot);
  recordWorkspaceSession(cortex, mockSnapshot);

  // Third session with only MySQL
  recordWorkspaceSession(cortex, {
    ...mockSnapshot,
    devPorts: [{ port: 3306, serviceInfo: { service: 'MySQL' } }],
  });

  const pData = cortex.projects['proj_test123'];
  assert.strictEqual(pData.sessionCount, 3);
  assert.strictEqual(pData.portFrequency['3306'], 3);
  assert.strictEqual(pData.portFrequency['5173'], 2);

  // Predict
  const prediction = predictWorkspaceRequirements(cortex, 'proj_test123');
  assert.ok(prediction);
  assert.strictEqual(prediction.sessionCount, 3);

  // MySQL appeared in 3/3 sessions -> 100%
  const mysqlPred = prediction.predictedServices.find((s) => s.service === 'MySQL');
  assert.ok(mysqlPred);
  assert.strictEqual(mysqlPred.confidence, 100);

  // Vite appeared in 2/3 sessions -> 67%
  const vitePort = prediction.predictedPorts.find((p) => p.port === 5173);
  assert.ok(vitePort);
  assert.strictEqual(vitePort.confidence, 67);

  // Recommended tabs
  assert.ok(prediction.recommendedTabs.length > 0);
  assert.ok(prediction.recommendedTabs.some((t) => t.url.includes('localhost:5173')));

  // Format terminal insights
  const output = formatCortexInsights(prediction, [3306]);
  assert.ok(output.includes('SWEP CORTEX'));
  assert.ok(output.includes('MySQL'));
  assert.ok(output.includes('ACTIVE'));
});

test('cortex habit: save and load memory encrypted at rest', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-cortex-test-'));
  try {
    const cortex = createDefaultCortex();
    cortex.projects['proj_demo'] = {
      sessionCount: 5,
      projectName: 'demo-app',
    };

    saveCortexMemory(tempDir, cortex);
    const loaded = loadCortexMemory(tempDir);

    assert.strictEqual(loaded.projects['proj_demo'].projectName, 'demo-app');
    assert.strictEqual(loaded.projects['proj_demo'].sessionCount, 5);

    // Verify file on disk is encrypted
    const rawDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'cortex.json'), 'utf8'));
    assert.strictEqual(rawDisk._protected, true);
    assert.ok(rawDisk.ciphertext);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cortex sniffer: classifyFileSemantic categorizes files properly', () => {
  assert.strictEqual(classifyFileSemantic('settings.json'), 'config');
  assert.strictEqual(classifyFileSemantic('config.yaml'), 'config');
  assert.strictEqual(classifyFileSemantic('workspace.sqlite'), 'working_state');
  assert.strictEqual(classifyFileSemantic('state.vscdb'), 'working_state');
  assert.strictEqual(classifyFileSemantic('auth_token.json'), 'auth_material');
  assert.strictEqual(classifyFileSemantic('credentials.db'), 'auth_material');
  assert.strictEqual(classifyFileSemantic('Cache/index.data'), 'cache');
});

test('cortex sniffer: locateAppStorageCandidates and inspectAppStorageFootprint', () => {
  const candidates = locateAppStorageCandidates('mockapp');
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length > 0);

  const tempAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swep-app-test-'));
  try {
    // Create mock app structure
    fs.mkdirSync(path.join(tempAppDir, 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(tempAppDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    fs.writeFileSync(path.join(tempAppDir, 'state.sqlite'), 'SQLITE_BINARY_DATA');
    fs.writeFileSync(path.join(tempAppDir, 'user_token.json'), JSON.stringify({ token: 'abc' }));
    fs.writeFileSync(path.join(tempAppDir, 'Cache', 'cache.tmp'), 'TEMP_DATA');

    const footprint = inspectAppStorageFootprint(tempAppDir);

    assert.ok(footprint.totalFiles >= 3);
    assert.ok(footprint.categories.cache.length >= 1);
    assert.ok(footprint.categories.config.some((c) => c.relPath === 'settings.json'));
    assert.ok(footprint.categories.working_state.some((c) => c.relPath === 'state.sqlite'));
    assert.ok(footprint.categories.auth_material.some((c) => c.relPath === 'user_token.json'));
    assert.ok(footprint.draftManifest.configPaths.includes('settings.json'));
  } finally {
    fs.rmSync(tempAppDir, { recursive: true, force: true });
  }
});

test('cortex monitor: LiveLogger rolling 10-line buffer and formatting', () => {
  const logger = new LiveLogger({
    maxLines: 10,
    account: 'test@gmail.com',
    maskedKey: 'nhatprx-7Kxx-xxx9',
    projectName: 'swep-dev',
  });

  // Add 15 logs
  for (let i = 1; i <= 15; i++) {
    logger.log(`Event number ${i}`);
  }

  // Must cap at 10 lines
  assert.strictEqual(logger.logs.length, 10);
  assert.ok(logger.logs[0].includes('Event number 6'));
  assert.ok(logger.logs[9].includes('Event number 15'));

  // Frame formatting
  const frame = logger.formatFrame();
  assert.ok(frame.includes('SWEP LIVE WORKSPACE MONITOR'));
  assert.ok(frame.includes('test@gmail.com'));
  assert.ok(frame.includes('nhatprx-7Kxx-xxx9'));
  assert.ok(frame.includes('swep-dev'));
  assert.ok(frame.includes('Event number 15'));
  assert.ok(frame.includes('Save & Exit'));

  logger.clear();
  assert.strictEqual(logger.isStopping, true);
});
