/**
 * Swep Session Capsule - Extension Background Service Worker
 * Tự động nạp cookies khi mở Chrome và đồng bộ cookies mới nhất về Swep CLI
 */

try {
  importScripts('config.js');
} catch (err) {
  // config.js will be loaded on startup
}

const bridgePort = (typeof self.SWEP_CONFIG !== 'undefined' && self.SWEP_CONFIG.port)
  ? self.SWEP_CONFIG.port
  : 0;

let syncTimeout = null;
let hasInjected = false;

// Bơm danh sách cookies vào Chrome
async function injectCookies(cookies, targetUrl) {
  if (!cookies || !cookies.length) return;

  for (const c of cookies) {
    try {
      const cleanDomain = (c.domain || '').startsWith('.') ? c.domain.slice(1) : (c.domain || '');
      const proto = c.secure ? 'https://' : 'http://';
      const path = c.path || '/';
      const cookieUrl = cleanDomain ? `${proto}${cleanDomain}${path}` : targetUrl;

      const details = {
        url: cookieUrl,
        name: c.name,
        value: c.value,
        path: path,
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
      };

      if (c.domain && !c.hostOnly) {
        details.domain = c.domain;
      }

      if (c.sameSite && c.sameSite !== 'unspecified') {
        details.sameSite = c.sameSite;
      }

      if (c.expirationDate && !c.session) {
        if (c.expirationDate > Math.floor(Date.now() / 1000)) {
          details.expirationDate = c.expirationDate;
        }
      }

      await chrome.cookies.set(details);
    } catch (err) {
      // ignore individual cookie set failures
    }
  }
}

// Lấy tất cả cookies từ trình duyệt và gửi về Swep Bridge
async function dumpAndSyncCookies() {
  if (!bridgePort) return;

  try {
    const allCookies = await chrome.cookies.getAll({});
    if (!allCookies || !allCookies.length) return;

    await fetch(`http://127.0.0.1:${bridgePort}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: allCookies }),
    });
  } catch (err) {
    // Bridge may be busy
  }
}

// Khởi chạy quy trình ban đầu
async function init() {
  if (!bridgePort) return;

  // 1. Lấy dữ liệu phiên từ Swep Bridge nếu có
  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/session`);
    const data = await res.json();

    if (data.cookies && data.cookies.length && !hasInjected) {
      hasInjected = true;
      const targetUrl = (typeof self.SWEP_CONFIG !== 'undefined' && self.SWEP_CONFIG.targetUrl)
        ? self.SWEP_CONFIG.targetUrl
        : 'https://accounts.google.com';

      await injectCookies(data.cookies, targetUrl);

      // Báo cho Bridge biết đã nạp xong
      await fetch(`http://127.0.0.1:${bridgePort}/injected`, { method: 'POST' });

      // Chuyển tab hiện tại sang myaccount để kiểm tra phiên
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.update(tabs[0].id, { url: 'https://myaccount.google.com' });
      }
    }
  } catch (err) {
    // ignore
  }

  // 2. Thu thập và gửi cookies hiện có ngay khi mở
  await dumpAndSyncCookies();

  // 3. Lắng nghe thay đổi cookie để tự động đồng bộ ngay lập tức (debounce 1s)
  chrome.cookies.onChanged.addListener(() => {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      dumpAndSyncCookies();
    }, 1000);
  });

  // 4. Heartbeat đồng bộ mỗi 10 giây
  setInterval(() => {
    dumpAndSyncCookies();
  }, 10000);
}

init();
