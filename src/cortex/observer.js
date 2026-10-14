/**
 * SWEP Cortex - Workspace Context Observer
 * Quan sát, phát hiện tiến trình, cổng mạng dev và ngữ cảnh dự án hiện tại
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import { runHiddenPowerShell } from '../chrome.js';

// Danh sách các cổng dev phổ biến và tên dịch vụ tương ứng
export const KNOWN_DEV_PORTS = {
  3306: { service: 'MySQL', type: 'database', defaultContainer: 'mysql' },
  5432: { service: 'PostgreSQL', type: 'database', defaultContainer: 'postgres' },
  6379: { service: 'Redis', type: 'cache', defaultContainer: 'redis' },
  27017: { service: 'MongoDB', type: 'database', defaultContainer: 'mongo' },
  1433: { service: 'MSSQL', type: 'database', defaultContainer: 'mssql' },
  9200: { service: 'Elasticsearch', type: 'search', defaultContainer: 'elasticsearch' },
  5173: { service: 'Vite Dev Server', type: 'frontend', defaultContainer: null },
  3000: { service: 'Node/Next.js/React', type: 'web', defaultContainer: null },
  8080: { service: 'Java/Spring/HTTP', type: 'backend', defaultContainer: null },
  8000: { service: 'Python/Django/FastAPI', type: 'backend', defaultContainer: null },
  4200: { service: 'Angular', type: 'frontend', defaultContainer: null },
};

/**
 * Tìm thư mục gốc của Git repository (nếu có)
 * @param {string} startDir
 * @returns {string|null}
 */
export function findGitRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Lấy thông tin Git (remote url, current branch, commit)
 * @param {string} gitRoot
 * @returns {Promise<{ remoteUrl: string|null, branch: string|null, commit: string|null }>}
 */
export async function getGitInfo(gitRoot) {
  if (!gitRoot || !fs.existsSync(path.join(gitRoot, '.git'))) {
    return { remoteUrl: null, branch: null, commit: null };
  }

  try {
    const escapedRoot = gitRoot.replace(/'/g, "''");
    const script = `
Set-Location -LiteralPath '${escapedRoot}'
$remote = git config --get remote.origin.url
$branch = git branch --show-current
$commit = git rev-parse --short HEAD
"$remote|$branch|$commit"
`;
    const out = await runHiddenPowerShell(script);
    const parts = out.split('|').map((s) => s.trim());
    return {
      remoteUrl: parts[0] || null,
      branch: parts[1] || null,
      commit: parts[2] || null,
    };
  } catch {
    return { remoteUrl: null, branch: null, commit: null };
  }
}

/**
 * Nhận diện loại dự án và các file cấu hình quan trọng
 * @param {string} projectDir
 * @returns {object}
 */
export function detectProjectConfigs(projectDir) {
  const configs = [];
  const technologies = [];

  const checkFile = (fileName, tech, configType) => {
    const full = path.join(projectDir, fileName);
    if (fs.existsSync(full)) {
      configs.push({ file: fileName, type: configType });
      if (tech && !technologies.includes(tech)) {
        technologies.push(tech);
      }
      return true;
    }
    return false;
  };

  checkFile('package.json', 'Node.js', 'package');
  checkFile('docker-compose.yml', 'Docker', 'container_orchestration');
  checkFile('docker-compose.yaml', 'Docker', 'container_orchestration');
  checkFile('Dockerfile', 'Docker', 'container');
  checkFile('requirements.txt', 'Python', 'package');
  checkFile('pyproject.toml', 'Python', 'package');
  checkFile('Pipfile', 'Python', 'package');
  checkFile('Cargo.toml', 'Rust', 'package');
  checkFile('go.mod', 'Go', 'package');
  checkFile('pom.xml', 'Java (Maven)', 'package');
  checkFile('build.gradle', 'Java (Gradle)', 'package');
  checkFile('.env', null, 'environment_variables');
  checkFile('.env.example', null, 'environment_template');
  checkFile('tsconfig.json', 'TypeScript', 'compiler_options');
  checkFile('vite.config.js', 'Vite', 'bundler');
  checkFile('vite.config.ts', 'Vite', 'bundler');

  // Đọc tên dự án từ package.json nếu có
  let projectName = path.basename(projectDir);
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) projectName = pkg.name;
    } catch {
      // ignore
    }
  }

  return { projectName, configs, technologies };
}

/**
 * Nhận diện toàn diện ngữ cảnh dự án (Project Fingerprint)
 * @param {string} [startDir=process.cwd()]
 * @returns {Promise<object>}
 */
export async function detectProjectContext(startDir = process.cwd()) {
  const gitRoot = findGitRoot(startDir);
  const projectDir = gitRoot || path.resolve(startDir);
  const gitInfo = await getGitInfo(projectDir);
  const { projectName, configs, technologies } = detectProjectConfigs(projectDir);

  // Sinh ID duy nhất định danh dự án dựa trên remote URL hoặc đường dẫn
  const seed = gitInfo.remoteUrl || projectDir.toLowerCase();
  const projectId = 'proj_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);

  return {
    projectId,
    projectName,
    projectDir,
    gitRoot,
    gitRemote: gitInfo.remoteUrl,
    gitBranch: gitInfo.branch,
    gitCommit: gitInfo.commit,
    configs,
    technologies,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Quét các cổng TCP đang được lắng nghe (Listening Ports) trên máy Windows
 * @returns {Promise<Array<{ port: number, pid: number, processName: string, serviceInfo: object|null }>>}
 */
export async function scanActiveListeningPorts() {
  try {
    const psScript = `
$conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') }
$results = @()

foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    $pname = if ($proc) { $proc.ProcessName } else { 'Unknown' }
    $results += "$($c.LocalPort)|$($c.OwningProcess)|$pname"
}
$results -join "\`n"
`;
    const stdout = await runHiddenPowerShell(psScript);
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const seenPorts = new Set();
    const ports = [];

    for (const line of lines) {
      const [portStr, pidStr, procName] = line.split('|');
      const port = parseInt(portStr, 10);
      const pid = parseInt(pidStr, 10);

      if (port && !seenPorts.has(port)) {
        seenPorts.add(port);
        const serviceInfo = KNOWN_DEV_PORTS[port] || null;
        ports.push({
          port,
          pid: pid || 0,
          processName: procName || 'Unknown',
          serviceInfo,
        });
      }
    }

    return ports.sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

/**
 * Lấy danh sách tabs đang mở từ Chrome CDP
 * @param {number} cdpPort
 * @returns {Promise<Array<{ title: string, url: string }>>}
 */
export function captureBrowserTabs(cdpPort) {
  if (!cdpPort) return Promise.resolve([]);

  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${cdpPort}/json/list`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const tabs = targets
            .filter((t) => t.type === 'page' && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('about:'))
            .map((t) => ({ title: t.title || '', url: t.url }));
          resolve(tabs);
        } catch {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

/**
 * Chụp ảnh toàn bộ không gian làm việc hiện tại (Workspace Snapshot)
 * @param {string} [projectDir=process.cwd()]
 * @param {number} [cdpPort=0]
 * @returns {Promise<object>}
 */
export async function captureCurrentWorkspaceSnapshot(projectDir = process.cwd(), cdpPort = 0) {
  const project = await detectProjectContext(projectDir);
  const activePorts = await scanActiveListeningPorts();
  const browserTabs = await captureBrowserTabs(cdpPort);

  // Lọc ra các port dev có ý nghĩa (database, web server...)
  const devPorts = activePorts.filter((p) => p.serviceInfo !== null || (p.port >= 3000 && p.port <= 9999));
  const containers = await detectActiveDockerContainers();
  const ides = await detectRunningIDEs(projectDir);

  return {
    timestamp: new Date().toISOString(),
    project,
    devPorts,
    allListeningPortsCount: activePorts.length,
    browserTabs,
    containers,
    ides,
  };
}

/**
 * Phát hiện các container Docker đang chạy (nếu có daemon)
 * @returns {Promise<Array<{ id: string, name: string, image: string, ports: string }>>}
 */
export async function detectActiveDockerContainers() {
  try {
    const script = `
try {
  $out = docker ps --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Ports}}" 2>$null
  if ($out) { $out }
} catch {}
`;
    const stdout = await runHiddenPowerShell(script);
    if (!stdout) return [];
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, name, image, ports] = l.split('|');
        return { id: id || '', name: name || '', image: image || '', ports: ports || '' };
      });
  } catch {
    return [];
  }
}

/**
 * Phát hiện IDE đang hoạt động (Cursor, VS Code, JetBrains)
 * @param {string} [projectDir=process.cwd()]
 * @returns {Promise<Array<{ name: string, pid: number, isProjectActive: boolean }>>}
 */
export async function detectRunningIDEs(projectDir = process.cwd()) {
  try {
    const escapedRoot = projectDir.replace(/'/g, "''");
    const script = `
$targetNames = @('Cursor.exe', 'Code.exe', 'idea64.exe', 'webstorm64.exe')
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -in $targetNames }
$results = @()
foreach ($p in $procs) {
  $isActive = ($p.CommandLine -and ($p.CommandLine -like "*${escapedRoot}*"))
  $results += "$($p.Name)|$($p.ProcessId)|$isActive"
}
$results -join "\`n"
`;
    const stdout = await runHiddenPowerShell(script);
    if (!stdout) return [];
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, pid, active] = l.split('|');
        return {
          name: name ? name.replace(/\.exe$/i, '') : 'IDE',
          pid: parseInt(pid, 10) || 0,
          isProjectActive: active === 'True',
        };
      });
  } catch {
    return [];
  }
}
