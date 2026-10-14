/**
 * SWEP Cortex - Live Workspace Monitor
 * Bảng theo dõi trực tiếp phiên làm việc: ghi lại nhật ký tối đa 10 dòng mới nhất,
 * ghi đè tại chỗ (in-place) và tự động nhận diện thay đổi của browser/port
 */

import http from 'http';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { maskKey } from '../bridge.js';
import {
  scanActiveListeningPorts,
  captureBrowserTabs,
  detectActiveDockerContainers,
  detectRunningIDEs,
} from './observer.js';
import { checkoutCommand } from '../commands/checkout.js';
import { downCommand } from '../commands/down.js';

/**
 * Class quản lý nhật ký cuộn 10 dòng ghi đè tại chỗ
 */
export class LiveLogger {
  constructor(options = {}) {
    this.maxLines = options.maxLines || 10;
    this.title = options.title || 'SWEP LIVE WORKSPACE MONITOR';
    this.account = options.account || 'Unknown';
    this.maskedKey = options.maskedKey || 'xxxx-xxxx';
    this.projectName = options.projectName || 'default';
    this.logs = [];
    this.lastRenderedLineCount = 0;
    this.isStopping = false;
  }

  /**
   * Thêm một dòng log mới và vẽ lại bảng
   * @param {string} message
   */
  log(message) {
    if (this.isStopping) return;
    const now = new Date();
    const timeStr = [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join(':');

    this.logs.push(`[${timeStr}] ${message}`);
    if (this.logs.length > this.maxLines) {
      this.logs.shift();
    }
    this.render();
  }

  /**
   * Định dạng giao diện khung theo dõi 10 dòng
   * @returns {string}
   */
  formatFrame() {
    const termWidth = Math.max(78, Math.min(process.stdout.columns || 80, 100));
    const innerWidth = termWidth - 4;

    const pad = (str, len) => {
      // Loại bỏ ansi để tính độ dài thực tế
      // eslint-disable-next-line no-control-regex
      const cleanLen = str.replace(/\x1b\[[0-9;]*m/g, '').length;
      if (cleanLen >= len) return str;
      return str + ' '.repeat(len - cleanLen);
    };

    const lines = [];
    lines.push(chalk.bold.cyan(`┌─ 🟢 ${this.title} `) + chalk.cyan('─'.repeat(Math.max(0, termWidth - this.title.length - 8))) + chalk.cyan('┐'));

    // Dòng thông tin header
    const infoLine = ` Account: ${chalk.white(this.account)} | Key: ${chalk.yellow(this.maskedKey)} | Project: ${chalk.green(this.projectName)}`;
    lines.push(chalk.cyan('│') + pad(infoLine, innerWidth + 2) + chalk.cyan('│'));
    lines.push(chalk.cyan('├' + '─'.repeat(termWidth - 2) + '┤'));

    // 10 dòng log mới nhất
    for (let i = 0; i < this.maxLines; i++) {
      const entry = this.logs[i];
      if (entry) {
        lines.push(chalk.cyan('│ ') + pad(entry, innerWidth) + chalk.cyan(' │'));
      } else {
        lines.push(chalk.cyan('│ ') + pad(chalk.dim('• ...'), innerWidth) + chalk.cyan(' │'));
      }
    }

    // Dòng hướng dẫn footer
    lines.push(chalk.cyan('├' + '─'.repeat(termWidth - 2) + '┤'));
    const footer = chalk.dim(' [Ctrl+C] Save & Exit | [q] Checkout Key | [o] Reopen Chrome');
    lines.push(chalk.cyan('│') + pad(footer, innerWidth + 2) + chalk.cyan('│'));
    lines.push(chalk.cyan('└' + '─'.repeat(termWidth - 2) + '┘'));

    return lines.join('\n');
  }

  /**
   * Ghi đè lại bảng log trên terminal
   */
  render() {
    if (!process.stdout.isTTY || this.isStopping) return;

    const frame = this.formatFrame();
    const frameLineCount = frame.split('\n').length;

    if (this.lastRenderedLineCount > 0) {
      // Di chuyển con trỏ lên lại số dòng đã vẽ và xóa từ đó về sau
      readline.cursorTo(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, -this.lastRenderedLineCount);
      process.stdout.write('\x1b[0J');
    }

    process.stdout.write(frame + '\n');
    this.lastRenderedLineCount = frameLineCount;
  }

  /**
   * Dọn sạch giao diện khi kết thúc
   */
  clear() {
    this.isStopping = true;
    if (this.lastRenderedLineCount > 0 && process.stdout.isTTY) {
      readline.cursorTo(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, -this.lastRenderedLineCount);
      process.stdout.write('\x1b[0J');
      this.lastRenderedLineCount = 0;
    }
  }
}

/**
 * Khởi chạy Live Workspace Monitor trong terminal
 * @param {object} params
 */
export async function startLiveWorkspaceMonitor(params) {
  const { rootDir, activeSession, project, browserExe, cdpPort } = params;

  const logger = new LiveLogger({
    account: activeSession.google_email || activeSession.handle,
    maskedKey: maskKey(activeSession.inputCode || activeSession.loginCode || activeSession.handle),
    projectName: project.projectName || 'workspace',
  });

  // Khởi tạo các log đầu tiên
  logger.log(chalk.green(`Workspace activated for ${activeSession.google_email || activeSession.handle}`));
  logger.log(`Browser: ${browserExe ? path.basename(browserExe) : 'Chrome'} (CDP port ${cdpPort}) [Status: Isolated & Protected]`);
  logger.log(`Cortex: Project anchor '${chalk.bold(project.projectName)}' [Monitoring tabs, IDE & Docker]`);

  let knownPorts = new Set();
  let knownTabs = new Set();
  let knownContainers = new Set();
  let knownIDEs = new Set();
  let tickCount = 0;
  let isExiting = false;

  // Lắng nghe phím tắt từ bàn phím (TTY)
  if (process.stdin.isTTY) {
    try {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();

      process.stdin.on('keypress', async (str, key) => {
        if (isExiting) return;

        // Ctrl+C: Save & Exit (downCommand)
        if ((key.ctrl && key.name === 'c') || str === '\u0003') {
          isExiting = true;
          logger.log(chalk.yellow('Received exit signal. Saving session to GitHub and cleaning up...'));
          await new Promise((r) => setTimeout(r, 600));
          logger.clear();
          process.stdin.setRawMode(false);
          await downCommand({ root: rootDir });
          process.exit(0);
        }

        // 'q': Checkout Key (checkoutCommand)
        if (key.name === 'q') {
          isExiting = true;
          logger.log(chalk.yellow('Checking out active key and saving session...'));
          await new Promise((r) => setTimeout(r, 600));
          logger.clear();
          process.stdin.setRawMode(false);
          await checkoutCommand({ root: rootDir });
          process.exit(0);
        }

        // 'o': Reopen Chrome
        if (key.name === 'o') {
          logger.log(chalk.cyan('Reopening active Chrome window...'));
          try {
            const { openSwepBrowser } = await import('../chrome.js');
            await openSwepBrowser(rootDir, 'https://www.google.com', cdpPort);
            logger.log(chalk.green('Browser window reopened'));
          } catch (err) {
            logger.log(chalk.red(`Failed to reopen browser: ${err.message}`));
          }
        }
      });
    } catch {
      // ignore TTY rawMode failure
    }
  }

  // Vòng lặp định kỳ theo dõi trạng thái
  const intervalId = setInterval(async () => {
    if (isExiting) return;

    // 1. Kiểm tra kết nối Chrome CDP
    if (cdpPort) {
      const isAlive = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${cdpPort}/json/version`, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1200, () => {
          req.destroy();
          resolve(false);
        });
      });

      if (!isAlive) {
        // Trình duyệt đã bị đóng
        logger.log(chalk.yellow('Browser window closed by user. Auto-saving session...'));
        isExiting = true;
        clearInterval(intervalId);
        await new Promise((r) => setTimeout(r, 1000));
        logger.clear();
        if (process.stdin.isTTY) {
          try { process.stdin.setRawMode(false); } catch {}
        }
        await checkoutCommand({ root: rootDir });
        process.exit(0);
      }
    }

    // 2. Quét các cổng dev mới mở & đánh giá
    try {
      const activePorts = await scanActiveListeningPorts();
      for (const p of activePorts) {
        if (!knownPorts.has(p.port)) {
          knownPorts.add(p.port);
          const sName = p.serviceInfo ? p.serviceInfo.service : 'Dev Service';
          logger.log(`🔌 [Port] ${chalk.bold(p.port)} (${chalk.cyan(sName)}) active [EVAL: Working state]`);
        }
      }
    } catch {
      // ignore
    }

    // 3. Quét tabs mới mở trong Chrome & đánh giá session
    if (cdpPort) {
      try {
        const tabs = await captureBrowserTabs(cdpPort);
        for (const t of tabs) {
          if (t.url && !knownTabs.has(t.url)) {
            knownTabs.add(t.url);
            const titleDisplay = t.title ? `"${t.title.slice(0, 24)}..."` : t.url;
            const isAuthOrDev = t.url.includes('github') || t.url.includes('google') || t.url.includes('localhost') || t.url.includes('jira');
            const evalText = isAuthOrDev ? chalk.yellow('[EVAL: Auth/Session -> Stage for backup]') : chalk.dim('[EVAL: Web tab]');
            logger.log(`🌐 [Chrome] ${chalk.blue(titleDisplay)} ${evalText}`);
          }
        }
      } catch {
        // ignore
      }
    }

    // 4. Phát hiện IDE (Cursor, VS Code) đang mở trên project
    try {
      const ides = await detectRunningIDEs(project.projectDir);
      for (const ide of ides) {
        const ideKey = `${ide.name}-${ide.pid}`;
        if (!knownIDEs.has(ideKey)) {
          knownIDEs.add(ideKey);
          const activeText = ide.isProjectActive ? chalk.green('focused on current project') : chalk.dim('running');
          logger.log(`💻 [IDE] ${chalk.bold.magenta(ide.name)} (${ide.pid}) ${activeText} [EVAL: Settings monitored]`);
        }
      }
    } catch {
      // ignore
    }

    // 5. Phát hiện Docker containers đang chạy
    try {
      const containers = await detectActiveDockerContainers();
      for (const c of containers) {
        if (!knownContainers.has(c.name)) {
          knownContainers.add(c.name);
          const portDisplay = c.ports ? ` (${c.ports.slice(0, 20)})` : '';
          logger.log(`🐳 [Docker] Container '${chalk.bold.green(c.name)}'${portDisplay} active [EVAL: Save compose state]`);
        }
      }
    } catch {
      // ignore
    }

    // 6. Nhịp tim định kỳ nếu không có thay đổi mới
    tickCount++;
    if (tickCount % 8 === 0) {
      logger.log(chalk.dim(`💓 [Heartbeat] Monitoring active: Chrome (${knownTabs.size} tabs), Ports (${knownPorts.size}), Docker (${knownContainers.size})`));
    }
  }, 3500);

  // Giữ tiến trình chạy ngầm
  return new Promise(() => {});
}
