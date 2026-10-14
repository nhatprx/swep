/**
 * SWEP Cortex - Habit Graph & Chronicle Engine
 * Ghi nhớ biên niên sử phiên làm việc, phân tích thói quen và dự đoán tài nguyên cần thiết
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import chalk from 'chalk';
import { aead_encrypt, aead_decrypt } from '../crypto.js';

/**
 * Khóa mã hóa bảo vệ cortex.json cục bộ
 */
function getHostKey() {
  const seedStr = [
    process.env.USERPROFILE || '',
    process.env.USERNAME || '',
    process.env.USERDOMAIN || '',
    process.env.COMPUTERNAME || '',
  ].join('::');
  return crypto.createHash('sha256').update(`swep/host/cortex:${seedStr}`).digest();
}

/**
 * Khởi tạo dữ liệu Cortex mặc định
 */
export function createDefaultCortex() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    projects: {},
  };
}

/**
 * Tải Cortex Memory từ file cục bộ hoặc từ userPayload trong vault
 * @param {string} rootDir
 * @param {object} [userPayload]
 * @returns {object}
 */
export function loadCortexMemory(rootDir, userPayload = null) {
  const file = path.join(rootDir, 'cortex.json');
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw._protected && raw.ciphertext) {
        const hostKey = getHostKey();
        return aead_decrypt(hostKey, raw, 'swep/cortex/v1');
      }
      return raw;
    } catch {
      // ignore
    }
  }

  // Fallback sang cortex lưu trong userPayload (đồng bộ từ GitHub Gist/Vault)
  if (userPayload && userPayload.cortex && typeof userPayload.cortex === 'object') {
    return userPayload.cortex;
  }

  return createDefaultCortex();
}

/**
 * Lưu Cortex Memory có mã hóa tại chỗ (At-Rest Protection)
 * @param {string} rootDir
 * @param {object} cortexData
 */
export function saveCortexMemory(rootDir, cortexData) {
  cortexData.updated_at = new Date().toISOString();
  const file = path.join(rootDir, 'cortex.json');
  try {
    const hostKey = getHostKey();
    const enc = aead_encrypt(hostKey, cortexData, 'swep/cortex/v1');
    fs.writeFileSync(file, JSON.stringify({ _protected: true, ...enc }, null, 2), 'utf8');
  } catch {
    fs.writeFileSync(file, JSON.stringify(cortexData, null, 2), 'utf8');
  }
}

/**
 * Ghi nhận một phiên snapshot vào Chronicle và cập nhật Habit Graph
 * @param {object} cortexData
 * @param {object} snapshot
 * @returns {object} updated cortexData
 */
export function recordWorkspaceSession(cortexData, snapshot) {
  if (!snapshot || !snapshot.project) return cortexData;

  const { project, devPorts = [], browserTabs = [] } = snapshot;
  const pId = project.projectId;

  if (!cortexData.projects[pId]) {
    cortexData.projects[pId] = {
      projectId: pId,
      projectName: project.projectName,
      projectDir: project.projectDir,
      gitRemote: project.gitRemote,
      technologies: project.technologies || [],
      sessionCount: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      portFrequency: {}, // { "3306": 12, "5173": 10 }
      serviceFrequency: {}, // { "MySQL": 12, "Vite": 10 }
      frequentTabs: {}, // { "http://localhost:5173": 8 }
      recentSessions: [],
    };
  }

  const pData = cortexData.projects[pId];
  pData.sessionCount += 1;
  pData.lastSeen = new Date().toISOString();
  pData.projectName = project.projectName;
  if (project.gitRemote) pData.gitRemote = project.gitRemote;

  // Cập nhật tần suất xuất hiện của ports và services
  for (const p of devPorts) {
    const portKey = String(p.port);
    pData.portFrequency[portKey] = (pData.portFrequency[portKey] || 0) + 1;

    if (p.serviceInfo && p.serviceInfo.service) {
      const sName = p.serviceInfo.service;
      pData.serviceFrequency[sName] = (pData.serviceFrequency[sName] || 0) + 1;
    }
  }

  // Cập nhật thói quen tabs trình duyệt
  for (const tab of browserTabs) {
    if (tab.url && !tab.url.startsWith('about:') && !tab.url.startsWith('chrome://')) {
      try {
        const parsed = new URL(tab.url);
        // Nhóm theo origin + pathname rút gọn để tránh tracking token
        const cleanKey = parsed.origin + parsed.pathname;
        pData.frequentTabs[cleanKey] = (pData.frequentTabs[cleanKey] || 0) + 1;
      } catch {
        // ignore invalid url
      }
    }
  }

  // Lưu lịch sử rút gọn (tối đa 20 session gần nhất để tiết kiệm dung lượng)
  pData.recentSessions.unshift({
    timestamp: new Date().toISOString(),
    ports: devPorts.map((p) => p.port),
    branch: project.gitBranch || null,
  });
  if (pData.recentSessions.length > 20) {
    pData.recentSessions = pData.recentSessions.slice(0, 20);
  }

  return cortexData;
}

/**
 * Dự đoán các tài nguyên, dịch vụ và tab mà người dùng sẽ cần cho project hiện tại
 * @param {object} cortexData
 * @param {string} projectId
 * @returns {object|null}
 */
export function predictWorkspaceRequirements(cortexData, projectId) {
  if (!cortexData || !cortexData.projects || !cortexData.projects[projectId]) {
    return null;
  }

  const pData = cortexData.projects[projectId];
  const total = pData.sessionCount;
  if (total <= 0) return null;

  const predictedServices = [];
  const predictedPorts = [];

  // Dự đoán ports có tần suất xuất hiện >= 35%
  for (const [portStr, count] of Object.entries(pData.portFrequency || {})) {
    const port = parseInt(portStr, 10);
    const confidence = Math.round((count / total) * 100);
    if (confidence >= 35) {
      predictedPorts.push({
        port,
        confidence,
        count,
      });
    }
  }

  // Dự đoán services
  for (const [sName, count] of Object.entries(pData.serviceFrequency || {})) {
    const confidence = Math.round((count / total) * 100);
    if (confidence >= 35) {
      predictedServices.push({
        service: sName,
        confidence,
        count,
      });
    }
  }

  // Top tabs thường mở
  const sortedTabs = Object.entries(pData.frequentTabs || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([url, count]) => ({
      url,
      confidence: Math.round((count / total) * 100),
    }));

  return {
    projectId,
    projectName: pData.projectName,
    sessionCount: total,
    lastSeen: pData.lastSeen,
    predictedServices: predictedServices.sort((a, b) => b.confidence - a.confidence),
    predictedPorts: predictedPorts.sort((a, b) => b.confidence - a.confidence),
    recommendedTabs: sortedTabs,
  };
}

/**
 * Định dạng báo cáo thói quen Workspace ra terminal đẹp mắt
 * @param {object} prediction
 * @param {Array<number>} [currentlyActivePorts=[]]
 * @returns {string}
 */
export function formatCortexInsights(prediction, currentlyActivePorts = []) {
  if (!prediction) return '';

  const lines = [];
  lines.push(chalk.bold.magenta('🧠 [SWEP CORTEX] ') + chalk.bold.white(`Workspace Habits: ${prediction.projectName}`) + chalk.dim(` (${prediction.sessionCount} past sessions)`));

  if (prediction.predictedServices.length > 0 || prediction.predictedPorts.length > 0) {
    lines.push(chalk.dim('   Predicted Dev Environment:'));
    for (const p of prediction.predictedPorts) {
      const isRunning = currentlyActivePorts.includes(p.port);
      const statusBadge = isRunning ? chalk.green('● ACTIVE') : chalk.yellow('○ IDLE');
      const sName = prediction.predictedServices.find((s) => s.service) || { service: `Port ${p.port}` };
      lines.push(`     • ${chalk.cyan(sName.service || `Port ${p.port}`)} (${p.port}) - ${chalk.bold(`${p.confidence}%`)} freq [${statusBadge}]`);
    }
  }

  if (prediction.recommendedTabs.length > 0) {
    lines.push(chalk.dim('   Habitual URLs:'));
    for (const t of prediction.recommendedTabs.slice(0, 3)) {
      lines.push(`     • ${chalk.underline.blue(t.url)} ${chalk.dim(`(${t.confidence}%)`)}`);
    }
  }

  return lines.join('\n');
}
