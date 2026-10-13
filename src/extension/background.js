/**
 * Swep Session Capsule - Extension Background Service Worker
 * Tự động nạp cookies khi mở Chrome và đồng bộ cookies mới nhất về Swep CLI
 */

let bridgePort = 0;
let syncTimeout = null;
let hasInjected = false;

// Đọc cấu hình từ config.json
async function loadConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'));
    const cfg = await res.json();
    bridgePort = cfg.port || 0;
    return cfg;
  } catch (err) {
    console.warn('[Swep] Không đọc được config.json:', err);
    return null;
  }
}

// Bơm danh sách cookies vào Chrome
async function injectCookies(cookies, targetUrl) {
  if (!cookies || !cookies.length) return;

  console.log(`[Swep] Đang nạp ${cookies.length} cookies vào Chrome...`);

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
        // Đảm bảo cookie còn hạn
        if (c.expirationDate > Math.floor(Date.now() / 1000)) {
          details.expirationDate = c.expirationDate;
        }
      }

      await chrome.cookies.set(details);
    } catch (err) {
      // Một số cookie đặc thù có thể bỏ qua nếu lỗi
    }
  }

  console.log('[Swep] Đã nạp xong toàn bộ cookies thành công!');
}

// Lấy tất cả cookies từ trình duyệt và gửi về Swep Bridge
async function dumpAndSyncCookies() {
  if (!bridgePort) return;

  try {
    const allCookies = await chrome.cookies.getAll({});
    // Lọc cookie Google và các trang liên quan
    const relevantCookies = allCookies.filter((c) => {
      const dom = (c.domain || '').toLowerCase();
      return dom.includes('google') || dom.includes('youtube') || dom.includes('github');
    });

    await fetch(`http://127.0.0.1:${bridgePort}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: relevantCookies.length ? relevantCookies : allCookies }),
    });
  } catch (err) {
    // Bridge có thể chưa sẵn sàng hoặc đã đóng
  }
}

// Khởi chạy quy trình ban đầu
async function init() {
  const cfg = await loadConfig();
  if (!cfg || !cfg.port) return;

  bridgePort = cfg.port;

  // 1. Lấy dữ liệu phiên từ Swep Bridge
  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/session`);
    const data = await res.json();

    if (data.cookies && data.cookies.length && !hasInjected) {
      hasInjected = true;
      await injectCookies(data.cookies, cfg.targetUrl || 'https://accounts.google.com');

      // Báo cho Bridge biết đã nạp xong
      await fetch(`http://127.0.0.1:${bridgePort}/injected`, { method: 'POST' });

      // Chuyển trang chủ tab hiện tại sang myaccount để kiểm tra phiên
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.update(tabs[0].id, { url: 'https://myaccount.google.com' });
      }
    }
  } catch (err) {
    console.warn('[Swep] Lỗi kết nối tới Bridge khi khởi động:', err);
  }

  // 2. Lắng nghe thay đổi cookie để tự động đồng bộ liên tục
  chrome.cookies.onChanged.addListener(() => {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      dumpAndSyncCookies();
    }, 2000);
  });

  // 3. Heartbeat định kỳ mỗi 15 giây
  setInterval(() => {
    dumpAndSyncCookies();
  }, 15000);
}

// Kích hoạt
init();
