/* PT 站详情页 · 豆瓣简介生成 —— 后台服务（Manifest V3）
 *
 * 只做两件事：
 *   1. 代理跨域请求：content script 处在站点页面里，直接 fetch 豆瓣 / IMDb 会被 CORS 拦掉，
 *      所以统一走这里。带上 credentials 以复用浏览器里已有的豆瓣登录态。
 *   2. 新标签打开链接（GM_openInTab 的替代）。
 *
 * 另外给豆瓣补 Referer：豆瓣 rexxar 接口对 Referer 有校验，而 fetch 规范不允许手动设置
 * Referer 头（会被忽略），只能用 declarativeNetRequest 在请求层改写。
 */

const REFERER_RULES = [
  { host: 'm.douban.com', referer: 'https://m.douban.com/' },
  { host: 'movie.douban.com', referer: 'https://movie.douban.com/' },
  { host: 'www.douban.com', referer: 'https://www.douban.com/' },
  { host: 'api.douban.com', referer: 'https://api.douban.com/' }
];

// 启动时安装一次会话级规则；失败（如无 DNR 权限）就静默降级，请求照发
async function installRefererRules() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  const rules = REFERER_RULES.map((r, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'referer', operation: 'set', value: r.referer }]
    },
    condition: {
      requestDomains: [r.host],
      resourceTypes: ['xmlhttprequest', 'other']
    }
  }));
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map(r => r.id),
      addRules: rules
    });
  } catch (e) {
    console.warn('[dbpt] 安装 Referer 规则失败，继续运行：', e && e.message);
  }
}

installRefererRules();
chrome.runtime.onInstalled.addListener(installRefererRules);
chrome.runtime.onStartup.addListener(installRefererRules);

// Referer 属于禁止头，fetch 里传了也会被忽略，这里主动剔掉，避免某些浏览器直接抛错
function cleanHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach(k => {
    if (/^referer$/i.test(k)) return;
    out[k] = h[k];
  });
  return out;
}

async function doFetch(msg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), msg.timeout || 15000);
  try {
    const res = await fetch(msg.url, {
      method: msg.method || 'GET',
      headers: cleanHeaders(msg.headers),
      body: msg.data || undefined,
      credentials: 'include',
      redirect: 'follow',
      signal: ctrl.signal
    });
    const text = await res.text();
    return { ok: true, status: res.status, text, url: res.url || msg.url };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'net') {
    doFetch(msg).then(sendResponse);
    return true;               // 异步返回
  }

  if (msg.type === 'open') {
    try {
      chrome.tabs.create({ url: String(msg.url), active: true });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    }
    return false;
  }

  return false;
});
