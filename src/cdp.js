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

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      const cdpCookies = cookies.map((c) => {
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
        if (exp && exp > Math.floor(Date.now() / 1000)) {
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
          resolve(true);
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
