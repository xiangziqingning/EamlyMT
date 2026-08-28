// API 余额查询 IPC（直连各平台官方接口）
const { ipcMain } = require('electron');
const https = require('https');

const PROVIDERS = {
  deepseek: {
    url: 'https://api.deepseek.com/user/balance',
    headers: (key) => ({ Authorization: 'Bearer ' + key })
  },
  openai: {
    urls: [
      { url: 'https://api.openai.com/v1/dashboard/billing/subscription', label: 'subscription' },
      { url: 'https://api.openai.com/v1/dashboard/billing/credit_grants', label: 'credit' }
    ],
    headers: (key) => ({ Authorization: 'Bearer ' + key })
  },
  moonshot: {
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    headers: (key) => ({ Authorization: 'Bearer ' + key })
  },
  siliconflow: {
    url: 'https://api.siliconflow.cn/v1/user/info',
    headers: (key) => ({ Authorization: 'Bearer ' + key })
  },
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/balance',
    headers: (key) => ({ Authorization: 'Bearer ' + key })
  }
};

function requestJson(url, headers, timeoutMs) {
  return new Promise(resolve => {
    const req = https.get(url, { headers, timeout: timeoutMs || 15000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = body.slice(0, 500); }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, error: '请求超时' }); });
    req.on('error', err => resolve({ status: 0, data: null, error: err.code || String(err) }));
  });
}

function register() {
  ipcMain.handle('api:balance', async (e, { provider, key }) => {
    const p = PROVIDERS[provider];
    if (!p) return { ok: false, error: '未知服务商' };
    if (!key || !key.trim()) return { ok: false, error: '请输入 API Key' };
    const headers = Object.assign({ 'Content-Type': 'application/json', 'User-Agent': 'workstation/1.0' }, p.headers(key.trim()));
    try {
      if (p.urls) {
        const results = {};
        for (const u of p.urls) results[u.label] = await requestJson(u.url, headers);
        return { ok: true, provider, results };
      }
      const r = await requestJson(p.url, headers);
      return { ok: true, provider, results: { main: r } };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}

module.exports = { register };
