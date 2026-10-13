/**
 * UI utilities: Prompts, banners, spinners, formatters
 */

import readline from 'readline';
import chalk from 'chalk';
import ora from 'ora';
import { getTOTP } from './crypto.js';
import { copyToClipboardWithAutoClear } from './chrome.js';

/**
 * Hiển thị banner Swep
 */
export function printBanner() {
  console.log(chalk.cyan.bold(`
  ╔═══════════════════════════════════════════════════════╗
  ║   ⚡ SWEP - Disposable Workplace & Chrome Profile     ║
  ║      Một lệnh để bắt đầu → Xong việc → Dọn sạch       ║
  ╚═══════════════════════════════════════════════════════╝
`));
}

/**
 * Hiển thị box thông báo quan trọng
 * @param {string} title
 * @param {string[]} lines
 * @param {'cyan'|'green'|'yellow'|'red'} color
 */
export function printBox(title, lines, color = 'cyan') {
  const border = chalk[color]('═'.repeat(55));
  console.log(border);
  console.log(chalk[color].bold(`  ${title.toUpperCase()}`));
  console.log(chalk[color]('─'.repeat(55)));
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  console.log(border);
}

/**
 * Prompt hỏi người dùng nhập text
 * @param {string} questionText
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
export function prompt(questionText, defaultValue = '') {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultValue ? ` (${chalk.dim(defaultValue)}): ` : ': ';

  return new Promise((resolve) => {
    rl.question(chalk.bold(questionText) + suffix, (answer) => {
      rl.close();
      const val = answer.trim() || defaultValue;
      resolve(val);
    });
  });
}

/**
 * Prompt nhập mật khẩu (che ký tự bằng *)
 * @param {string} questionText
 * @returns {Promise<string>}
 */
export function promptSecret(questionText) {
  return new Promise((resolve) => {
    process.stdout.write(chalk.bold(questionText) + ': ');
    const stdin = process.stdin;
    const isRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';

    const onData = (ch) => {
      const char = String(ch);
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(isRaw);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '\u0003') {
        // Ctrl+C
        stdin.setRawMode(isRaw);
        stdin.pause();
        process.stdout.write('\n');
        process.exit(1);
      } else if (char === '\b' || char === '\x7f') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (char === '\u0016') {
        // Bỏ qua ký tự điều khiển Ctrl+V trong raw mode
      } else {
        password += char;
        process.stdout.write('*'.repeat(char.length));
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Prompt xác nhận Yes/No
 * @param {string} questionText
 * @param {boolean} defaultYes
 * @returns {Promise<boolean>}
 */
export async function promptConfirm(questionText, defaultYes = true) {
  const defaultHint = defaultYes ? '[Y/n]' : '[y/N]';
  const ans = await prompt(`${questionText} ${defaultHint}`);
  if (!ans) return defaultYes;
  return ans.toLowerCase().startsWith('y');
}

/**
 * Spinner wrapper
 * @param {string} text
 * @returns {import('ora').Ora}
 */
export function createSpinner(text) {
  return ora({
    text,
    color: 'cyan',
  }).start();
}

/**
 * Chạy màn hình điều khiển phiên Swep trực tiếp (Live Session Dashboard & 2FA Ticker)
 * @param {object} options
 * @param {string} options.email
 * @param {string} [options.totpSecret]
 * @param {() => Array} options.getLatestCookies
 * @param {() => Promise<void>} options.onOpenChrome
 * @param {() => Promise<void>} options.onDone
 * @returns {Promise<void>}
 */
export function startLiveSessionDashboard({
  email,
  password = '',
  totpSecret = '',
  getLatestCookies = () => [],
  onOpenChrome = async () => {},
  onDone = async () => {},
}) {
  return new Promise((resolve) => {
    console.log();
    console.log(chalk.cyan('─────────────────────────────────────────────────────────────'));
    console.log(chalk.cyan.bold('  ⚡ SWEP DISPOSABLE WORKPLACE (Profile Cô Lập Đang Chạy)'));
    console.log(`     Tài khoản: ${chalk.bold(email)}`);
    const shortcuts = ['[O] Mở Chrome'];
    if (password) shortcuts.push('[P] Copy Mật khẩu');
    if (totpSecret) shortcuts.push('[C] Copy mã 2FA');
    shortcuts.push('[D] Xong & Dọn dẹp', '[Q] Thoát');
    console.log(chalk.dim(`     Phím tắt:  ${shortcuts.join('  |  ')}`));
    console.log(chalk.cyan('─────────────────────────────────────────────────────────────\n'));

    let timer = null;
    let isCleaningUp = false;

    const render = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const cookies = getLatestCookies();
      const cookieText = cookies.length ? `${cookies.length} cookies` : 'Đang đợi đăng nhập...';

      if (totpSecret) {
        let code = '000000';
        try {
          code = getTOTP(totpSecret, nowSec);
        } catch {
          // ignore
        }
        const remaining = 30 - (nowSec % 30);
        const formattedCode = `${code.slice(0, 3)} ${code.slice(3)}`;
        const filled = Math.round((remaining / 30) * 12);
        const empty = 12 - filled;
        const barStr = '█'.repeat(filled) + '░'.repeat(empty);
        const barColor = remaining <= 5 ? chalk.red : remaining <= 10 ? chalk.yellow : chalk.green;
        const timeColor = remaining <= 5 ? chalk.red.bold : chalk.white;

        process.stdout.write(
          `\r  🔐 2FA: ${chalk.bgCyan.black.bold(` ${formattedCode} `)}  ⏳ ${timeColor(`${String(remaining).padStart(2, ' ')}s`)} [${barColor(barStr)}]  •  Capsule: ${chalk.cyan(cookieText)}   `
        );
      } else {
        process.stdout.write(
          `\r  ⚡ Session: ${chalk.green('Đang kết nối')}  •  Capsule: ${chalk.cyan(cookieText)}  •  (Bấm [D] để xong)   `
        );
      }
    };

    render();
    timer = setInterval(render, 1000);

    const cleanupAndResolve = () => {
      if (timer) clearInterval(timer);
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
          process.stdin.pause();
        } catch {
          // ignore
        }
      }
      process.stdout.write('\n\n');
      resolve();
    };

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onKey = async (key) => {
        if (isCleaningUp) return;
        const ch = String(key).toLowerCase();

        if (ch === 'p' && password) {
          await copyToClipboardWithAutoClear(password, 25);
          process.stdout.write(`\r  ✔ Đã copy Mật khẩu vào Clipboard (sẽ tự xóa sau 25s)!             \n`);
        } else if (ch === 'c' && totpSecret) {
          const nowSec = Math.floor(Date.now() / 1000);
          const currentCode = getTOTP(totpSecret, nowSec);
          await copyToClipboardWithAutoClear(currentCode, 25);
          process.stdout.write(`\r  ✔ Đã copy mã 2FA (${currentCode}) vào Clipboard!                   \n`);
        } else if (ch === 'o') {
          process.stdout.write(`\r  ✔ Đang mở lại cửa sổ Chrome của Swep...                          \n`);
          await onOpenChrome();
        } else if (ch === 'd') {
          isCleaningUp = true;
          process.stdin.removeListener('data', onKey);
          cleanupAndResolve();
          await onDone();
        } else if (ch === 'q' || ch === '\u0003') {
          // 'q' hoặc Ctrl+C
          process.stdin.removeListener('data', onKey);
          cleanupAndResolve();
          console.log(chalk.green('✔ Phiên Swep vẫn đang chạy trong nền.'));
          console.log(chalk.dim('Khi hoàn tất công việc, hãy mở terminal và gõ: swep down\n'));
        }
      };

      process.stdin.on('data', onKey);
    }
  });
}
