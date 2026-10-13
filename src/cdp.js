/**
 * Chrome DevTools Protocol (CDP) Manager for Swep
 * Quản lý kết nối trực tiếp với Chrome qua CDP WebSocket
 * để nạp (inject) và trích xuất (extract) Cookies phiên làm việc 100% chuẩn xác
 */

import http from 'http';
import net from 'net';

/**
 * Tìm một port ngẫu nhiên còn trống trên 127.0.0.1
 * @returns {Promise<number>}
 */
export function getFreePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Lấy WebSocket URL của Chrome CDP
 * @param {number} port
 * @param {number} [retries=15]
 * @returns {Promise<string>}
 */
export function getCDPWebSocketUrl(port, retries = 15) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryConnect = () => {
      attempt++;
      http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const v = JSON.parse(data);
            if (v.webSocketDebuggerUrl) {
              return resolve(v.webSocketDebuggerUrl);
            }
          } catch {
            // ignore
          }
          if (attempt < retries) {
            setTimeout(tryConnect, 400);
          } else {
            reject(new Error('Không thể kết nối CDP của Chrome (timeout).'));
          }
        });
      }).on('error', () => {
        if (attempt < retries) {
          setTimeout(tryConnect, 400);
        } else {
          reject(new Error('Chrome CDP chưa sẵn sàng trên port ' + port));
        }
      });
    };
    tryConnect();
  });
}

/**
 * Bơm danh sách cookies vào Chrome qua CDP Storage.setCookies
 * @param {number} port
 * @param {Array<object>} cookies
 * @returns {Promise<boolean>}
 */
export async function injectCookiesViaCDP(port, cookies) {
  if (!cookies || !cookies.length) return true;

  const wsUrl = await getCDPWebSocketUrl(port);
  const now = Math.floor(Date.now() / 1000);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      const cdpCookies = cookies
        .filter((c) => {
          const exp = c.expires || c.expirationDate;
          if (exp && exp !== -1 && exp < now) return false;
          return true;
        })
        .map((c) => {
          const item = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: Boolean(c.secure),
            httpOnly: Boolean(c.httpOnly),
          };
          if (c.sameSite && c.sameSite !== 'unspecified') {
            item.sameSite = c.sameSite;
          }
          const exp = c.expires || c.expirationDate;
          if (exp && exp > now) {
            item.expires = exp;
          }
          return item;
        });

      ws.send(JSON.stringify({
        id: 1,
        method: 'Storage.setCookies',
        params: { cookies: cdpCookies },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === 1) {
          ws.close();
          if (msg.error) {
            reject(new Error(msg.error.message || 'Lỗi nạp cookies qua CDP.'));
          } else {
            resolve(true);
          }
        }
      } catch (err) {
        ws.close();
        reject(err);
      }
    };

    ws.onerror = (err) => {
      reject(err);
    };
  });
}

/**
 * Điều hướng tab hiện tại của Chrome tới targetUrl qua CDP Page.navigate
 * @param {number} port
 * @param {string} targetUrl
 * @returns {Promise<object>}
 */
export async function navigatePageViaCDP(port, targetUrl) {
  const targetsRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await targetsRes.json();
  const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    throw new Error('Không tìm thấy tab trang nào trong Chrome CDP.');
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 100,
        method: 'Page.navigate',
        params: { url: targetUrl },
      }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === 100) {
          ws.close();
          resolve(msg.result);
        }
      } catch (err) {
        ws.close();
        reject(err);
      }
    };
    ws.onerror = (err) => reject(err);
  });
}

/**
 * Trích xuất toàn bộ cookies đang hoạt động từ Chrome qua CDP Storage.getCookies
 * @param {number} port
 * @returns {Promise<Array<object>>}
 */
export async function getCookiesViaCDP(port) {
  const wsUrl = await getCDPWebSocketUrl(port);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Storage.getCookies',
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === 1) {
          ws.close();
          const all = msg.result?.cookies || [];
          resolve(all);
        }
      } catch (err) {
        ws.close();
        reject(err);
      }
    };

    ws.onerror = (err) => {
      reject(err);
    };
  });
}

/**
 * Đóng Chrome nhẹ nhàng qua CDP Browser.close để flush sạch database và ghi exit_type Normal
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function closeChromeViaCDP(port) {
  if (!port) return false;
  try {
    const wsUrl = await getCDPWebSocketUrl(port, 3);
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 999, method: 'Browser.close' }));
        setTimeout(() => {
          try { ws.close(); } catch {}
          resolve(true);
        }, 1200);
      };
      ws.onmessage = () => {
        try { ws.close(); } catch {}
        resolve(true);
      };
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2500);
    });
  } catch {
    return false;
  }
}
