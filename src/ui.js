/**
 * UI utilities: Prompts, banners, spinners, formatters
 */

import readline from 'readline';
import chalk from 'chalk';
import ora from 'ora';

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
      } else {
        password += char;
        process.stdout.write('*');
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
