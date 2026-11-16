/* PT 站详情页 · 豆瓣简介生成 —— 扩展垫片（在 content.js 之前注入）
 *
 * 把油猴的 GM_* 接口映射到 Chrome 扩展 API，脚本正文一行都不用改：
 *   GM_getValue / GM_setValue  → chrome.storage.local（启动时一次性读进内存，保证同步读）
 *   GM_xmlhttpRequest          → 转发给 background 里 fetch（content script 跨域会被 CORS 拦）
 *   GM_setClipboard            → navigator.clipboard，失败退回 execCommand
 *   GM_openInTab               → background 里 chrome.tabs.create
 *
 * 存储是异步的，所以脚本正文用 __DBPT_EXT.ready(fn) 包一层，等配置读进内存再跑。
 */
(function () {
  'use strict';

  var cache = null;          // null = 还没读到存储
  var waiting = [];          // 等存储就绪的回调

  function flush() {
    var list = waiting;
    waiting = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](); } catch (e) { /* 单个回调出错不影响其它 */ }
    }
  }

  function loadStore() {
    try {
      chrome.storage.local.get(null, function (all) {
        if (cache === null) { cache = all || {}; flush(); }
      });
    } catch (e) {
      cache = {};
      flush();
    }
  }

  loadStore();
  // 兜底：存储回调迟迟不来（极少数扩展上下文异常）也不能让面板一直不出来
  setTimeout(function () {
    if (cache === null) { cache = {}; flush(); }
  }, 2000);

  // 其它标签页改了配置时同步内存，避免旧值把新设置覆盖回去
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || cache === null) return;
      Object.keys(changes).forEach(function (k) {
        if (changes[k] && Object.prototype.hasOwnProperty.call(changes[k], 'newValue')) {
          cache[k] = changes[k].newValue;
        }
      });
    });
  } catch (e) { /* ignore */ }

  window.GM_getValue = function (key, dflt) {
    if (cache && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    return dflt;
  };

  window.GM_setValue = function (key, value) {
    if (cache) cache[key] = value;
    try {
      var patch = {};
      patch[key] = value;
      chrome.storage.local.set(patch);
    } catch (e) { /* ignore */ }
  };

  function copyByCommand(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.parentNode.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  window.GM_setClipboard = function (text) {
    var t = String(text == null ? '' : text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).catch(function () { copyByCommand(t); });
        return;
      }
    } catch (e) { /* 落到兜底 */ }
    copyByCommand(t);
  };

  window.GM_openInTab = function (url) {
    try {
      chrome.runtime.sendMessage({ type: 'open', url: String(url) }, function () {
        void chrome.runtime.lastError;   // 吞掉「消息无人接收」，避免控制台报错
      });
    } catch (e) {
      try { window.open(url, '_blank'); } catch (e2) { /* ignore */ }
    }
  };

  window.GM_xmlhttpRequest = function (opts) {
    opts = opts || {};
    var done = false;
    var timer = 0;

    function finish(fn, arg) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (typeof fn === 'function') {
        try { fn(arg); } catch (e) { /* ignore */ }
      }
    }

    timer = setTimeout(function () { finish(opts.ontimeout); }, opts.timeout || 15000);

    var payload = {
      type: 'net',
      method: opts.method || 'GET',
      url: opts.url,
      headers: opts.headers || {},
      data: opts.data == null ? null : opts.data,
      timeout: opts.timeout || 15000
    };

    try {
      chrome.runtime.sendMessage(payload, function (res) {
        if (chrome.runtime.lastError || !res || !res.ok) { finish(opts.onerror); return; }
        finish(opts.onload, {
          status: res.status,
          statusText: String(res.status),
          responseText: res.text,
          response: res.text,
          finalUrl: res.url
        });
      });
    } catch (e) {
      finish(opts.onerror);
    }
  };

  var manifest = {};
  try { manifest = chrome.runtime.getManifest() || {}; } catch (e) { /* ignore */ }

  window.__DBPT_EXT = {
    version: manifest.version || '',
    isExtension: true,
    // 脚本正文等存储就绪后再执行
    ready: function (fn) {
      if (cache !== null) {
        try { fn(); } catch (e) { console.error('[dbpt]', e); }
      } else {
        waiting.push(function () {
          try { fn(); } catch (e) { console.error('[dbpt]', e); }
        });
      }
    }
  };
})();
