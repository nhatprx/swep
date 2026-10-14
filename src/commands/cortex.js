/**
 * Command: swep cortex (status / habits / memory)
 * Hiển thị nhận diện không gian làm việc, thói quen và dự đoán tài nguyên của SWEP Cortex
 */

import chalk from 'chalk';
import { getSwepRoot } from '../chrome.js';
import { readActiveSession, maskKey } from '../bridge.js';
import { detectProjectContext, scanActiveListeningPorts } from '../cortex/observer.js';
import { loadCortexMemory, predictWorkspaceRequirements, formatCortexInsights } from '../cortex/habit.js';
import { locateAppStorageCandidates, inspectAppStorageFootprint } from '../cortex/sniffer.js';
import { captureGitStateBundle } from '../cortex/git_engine.js';

export async function cortexCommand(options = {}) {
  const rootDir = getSwepRoot(options.root);
  const activeSession = readActiveSession(rootDir);

  // Nếu người dùng muốn xem preview Git snapshot: `swep cortex --git`
  if (options.git) {
    try {
      const gitState = captureGitStateBundle(process.cwd());
      console.log(chalk.bold.cyan('\n📦 [SWEP CORTEX GIT ENGINE] Snapshot Preview:'));
      console.log(`  • Branch:   ${chalk.green(gitState.meta.currentBranch || 'detached')}`);
      console.log(`  • Upstream: ${chalk.dim(gitState.meta.upstreamRef || 'none')}`);
      console.log(`  • Base:     ${chalk.dim(gitState.meta.baseCommit || 'none')}`);
      console.log(`  • Bundle:   ${chalk.bold(gitState.bundleBuffer.length)} bytes`);
      console.log(`  • Untracked files captured: ${chalk.green(gitState.meta.untrackedCount)}`);
      if (gitState.meta.inProgressState) {
        console.log(chalk.yellow(`  • In-progress git operations: ${gitState.meta.inProgressState.join(', ')}`));
      }
      if (gitState.meta.skippedLargeFiles.length > 0) {
        console.log(chalk.yellow(`  • Skipped large files (>50MB): ${gitState.meta.skippedLargeFiles.map((f) => f.path).join(', ')}`));
      }
      console.log();
      return;
    } catch (err) {
      console.error(chalk.red(`Git snapshot error: ${err.message}`));
      return;
    }
  }

  // Nếu người dùng yêu cầu quét ứng dụng mới: `swep cortex --sniff <appName>`
  if (options.sniff) {
    const appName = options.sniff;
    console.log(chalk.bold.magenta('\n🔍 [SWEP CORTEX APP SNIFFER] ') + chalk.bold.white(`Scanning for application '${appName}'...`));
    const candidates = locateAppStorageCandidates(appName);
    const existing = candidates.filter((c) => c.exists);

    if (existing.length === 0) {
      console.log(chalk.yellow(`No standard storage folders found for '${appName}'. Checked:`));
      for (const c of candidates) {
        console.log(chalk.dim(`  - ${c.path} (${c.scope})`));
      }
      return;
    }

    console.log(chalk.green(`Found ${existing.length} storage locations:`));
    for (const c of existing) {
      console.log(`  • ${chalk.cyan(c.path)} ${chalk.dim(`[${c.scope}]`)}`);
      try {
        const footprint = inspectAppStorageFootprint(c.path);
        console.log(chalk.dim(`    Files: ${footprint.totalFiles} | Estimated payload: ${(footprint.draftManifest.estimatedPayloadSize / 1024).toFixed(1)} KB`));
        if (footprint.draftManifest.configPaths.length > 0) {
          console.log(chalk.dim(`    Config samples: ${footprint.draftManifest.configPaths.slice(0, 3).join(', ')}`));
        }
        if (footprint.draftManifest.authPaths.length > 0) {
          console.log(chalk.yellow(`    Auth samples: ${footprint.draftManifest.authPaths.slice(0, 2).join(', ')}`));
        }
      } catch {
        // ignore
      }
    }
    console.log();
    return;
  }

  // Chế độ mặc định: Hiển thị trạng thái ngữ cảnh workspace hiện tại
  console.log();
  if (activeSession) {
    const key = activeSession.loginCode || activeSession.handle;
    console.log(chalk.dim('active session: ') + chalk.cyan(maskKey(key)) + chalk.dim(` (${activeSession.google_email || 'authenticated'})`));
  } else {
    console.log(chalk.dim('active session: ') + chalk.yellow('none (run "swep <code>" to launch)'));
  }

  const projectContext = await detectProjectContext(process.cwd());
  const activePorts = await scanActiveListeningPorts();
  const portNumbers = activePorts.map((p) => p.port);

  console.log(chalk.dim('current workspace: ') + chalk.bold.green(projectContext.projectName) + chalk.dim(` [${projectContext.projectId}]`));
  if (projectContext.gitRemote) {
    console.log(chalk.dim('git remote:        ') + chalk.underline(projectContext.gitRemote) + (projectContext.gitBranch ? chalk.dim(` (${projectContext.gitBranch})`) : ''));
  }
  if (projectContext.technologies.length > 0) {
    console.log(chalk.dim('detected stack:    ') + chalk.cyan(projectContext.technologies.join(', ')));
  }

  // Tải cortex memory
  const cortexData = loadCortexMemory(rootDir, activeSession?.userPayload);
  const prediction = predictWorkspaceRequirements(cortexData, projectContext.projectId);

  console.log();
  if (prediction) {
    console.log(formatCortexInsights(prediction, portNumbers));
  } else {
    console.log(chalk.dim('🧠 [SWEP CORTEX] ') + chalk.dim(`No past habits recorded yet for this project. Cortex will automatically learn your patterns as you work.`));
  }

  // Liệt kê các port dev đang chạy hiện thời
  const devPorts = activePorts.filter((p) => p.serviceInfo || (p.port >= 3000 && p.port <= 9999));
  if (devPorts.length > 0) {
    console.log();
    console.log(chalk.dim('currently listening dev ports:'));
    for (const p of devPorts) {
      const sName = p.serviceInfo?.service ? chalk.cyan(p.serviceInfo.service) : chalk.dim('custom');
      console.log(`  • ${chalk.bold(p.port)}: ${sName} ${chalk.dim(`(PID ${p.pid} - ${p.processName})`)}`);
    }
  }

  console.log();
}
