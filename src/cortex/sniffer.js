/**
 * SWEP Cortex - Universal App Storage Sniffer & Semantic Classifier
 * Tự động phát hiện vị trí lưu trữ cấu hình, trạng thái làm việc và thông tin đăng nhập của ứng dụng
 */

import fs from 'fs';
import path from 'path';

// Danh sách các đuôi và tên file cấu hình
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.conf', '.properties', '.cfg']);

// Danh sách các định dạng database / state
const STATE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db', '.db3', '.vscdb', '.ldb', '.log']);

// Các từ khóa chỉ định dữ liệu xác thực / nhạy cảm
const AUTH_KEYWORDS = ['credential', 'auth', 'token', 'secret', 'key', 'cookie', 'session', 'login'];

// Các thư mục rác / cache tạm cần bỏ qua
const CACHE_DIR_NAMES = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawncache',
  'shadercache',
  'crashpad',
]);

/**
 * Phân loại ngữ nghĩa của một file (Semantic Classification)
 * @param {string} filePath
 * @param {fs.Stats} [stat]
 * @returns {'config' | 'working_state' | 'auth_material' | 'cache' | 'data'}
 */
export function classifyFileSemantic(filePath, _stat = null) {
  const fileName = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  const segments = filePath.toLowerCase().split(/[/\\]/);

  // 1. Kiểm tra cache theo từng folder segment hoặc filename
  for (const seg of segments) {
    if (CACHE_DIR_NAMES.has(seg) || seg.endsWith('cache')) {
      return 'cache';
    }
  }
  if (fileName.endsWith('.tmp') || fileName.endsWith('.bak') || fileName.endsWith('.old')) {
    return 'cache';
  }

  // 2. Kiểm tra auth / credentials
  for (const kw of AUTH_KEYWORDS) {
    if (fileName.includes(kw)) {
      return 'auth_material';
    }
  }

  // 3. Kiểm tra config
  if (CONFIG_EXTENSIONS.has(ext)) {
    return 'config';
  }

  // 4. Kiểm tra working state / database
  if (STATE_EXTENSIONS.has(ext)) {
    return 'working_state';
  }

  return 'data';
}

/**
 * Tìm kiếm các vị trí lưu trữ tiềm năng của một ứng dụng trên Windows
 * @param {string} appName Tên ứng dụng (ví dụ: 'cursor', 'postman', 'dbeaver')
 * @returns {Array<{ path: string, scope: string, exists: boolean }>}
 */
export function locateAppStorageCandidates(appName) {
  const norm = appName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!norm) return [];

  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming');
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';

  const candidates = [
    { path: path.join(appData, norm), scope: 'Roaming (Configs & Preferences)' },
    { path: path.join(localAppData, norm), scope: 'Local (State & Cache)' },
    { path: path.join(userProfile, `.${norm}`), scope: 'User Home (Config dotfile)' },
    { path: path.join(userProfile, '.config', norm), scope: 'User .config' },
  ];

  return candidates.map((c) => ({
    ...c,
    exists: fs.existsSync(c.path),
  }));
}

/**
 * Quét toàn bộ thư mục của một ứng dụng và phân tích dung lượng, phân loại cấu hình
 * @param {string} targetDir
 * @param {number} [maxDepth=4]
 * @returns {{ totalFiles: number, totalSizeBytes: number, categories: object, draftManifest: object }}
 */
export function inspectAppStorageFootprint(targetDir, maxDepth = 4) {
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Thư mục không tồn tại: ${targetDir}`);
  }

  const result = {
    targetDir,
    totalFiles: 0,
    totalSizeBytes: 0,
    categories: {
      config: [],
      working_state: [],
      auth_material: [],
      cache: [],
      data: [],
    },
  };

  function walk(currentDir, currentDepth) {
    if (currentDepth > maxDepth) return;

    let items;
    try {
      items = fs.readdirSync(currentDir);
    } catch {
      return;
    }

    for (const item of items) {
      const full = path.join(currentDir, item);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        const lower = item.toLowerCase();
        if (CACHE_DIR_NAMES.has(lower) || lower.endsWith('cache')) {
          result.categories.cache.push(full);
          continue;
        }
        walk(full, currentDepth + 1);
      } else if (stat.isFile()) {
        result.totalFiles += 1;
        result.totalSizeBytes += stat.size;

        const classification = classifyFileSemantic(full, stat);
        result.categories[classification].push({
          relPath: path.relative(targetDir, full),
          size: stat.size,
        });
      }
    }
  }

  walk(targetDir, 0);

  // Sinh bản thảo manifest tự động (Draft Manifest)
  const draftManifest = {
    appName: path.basename(targetDir),
    detectedAt: new Date().toISOString(),
    configPaths: result.categories.config.slice(0, 20).map((c) => c.relPath),
    statePaths: result.categories.working_state.slice(0, 20).map((c) => c.relPath),
    authPaths: result.categories.auth_material.slice(0, 20).map((c) => c.relPath),
    recommendedExclusions: ['**/Cache/**', '**/Code Cache/**', '**/*.log', '**/*.tmp'],
    estimatedPayloadSize: result.categories.config.reduce((acc, c) => acc + c.size, 0) +
      result.categories.working_state.reduce((acc, c) => acc + c.size, 0),
  };

  return {
    ...result,
    draftManifest,
  };
}
