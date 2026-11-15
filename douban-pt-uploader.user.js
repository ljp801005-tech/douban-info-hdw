// ==UserScript==
// @name         HDWing 详情页 · 豆瓣简介生成
// @name:en      HDWing Detail · Douban Intro Generator
// @namespace    https://github.com/techmovie/DouBan-Info-for-PT
// @version      2.6.0
// @description  仅在 hdwing.org 种子详情页启用：粘贴豆瓣条目链接，点「生成」一键得到「◎片名 / ◎译名 / ◎导演 / ◎编剧 / ◎主演 / ◎简介」格式的简介。没有豆瓣链接时粘贴 IMDb 链接同样可生成（先反查豆瓣，匹配不到直接用 IMDb 数据出简介）。打开页面只把链接填进输入框、点「生成」才请求，左上角只有一个「豆」入口、默认收起，底色即状态，毛玻璃界面，每周自动检查新版本。
// @updateURL    https://raw.githubusercontent.com/ljp801005-tech/douban-info-hdw/main/douban-pt-uploader.user.js
// @downloadURL  https://raw.githubusercontent.com/ljp801005-tech/douban-info-hdw/main/douban-pt-uploader.user.js
// @author       WorkBuddy
// @match        https://hdwing.org/*
// @match        http://hdwing.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @connect      m.douban.com
// @connect      movie.douban.com
// @connect      www.douban.com
// @connect      api.douban.com
// @connect      *.douban.com
// @connect      *.doubanio.com
// @connect      v3.sg.media-imdb.com
// @connect      v3-cinemeta.strem.io
// @connect      cinemeta-live.strem.io
// @connect      images.metahub.space
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 抓取链路（2026-11 实测）：
 *  1. m.douban.com/rexxar/api/v2/movie/{id}?for_mobile=1   主数据（必须带 Referer）
 *  2. api.douban.com/v2/movie/subject/{id}                 备用（POST apikey）
 *  3. www.douban.com/doubanapp//h5/movie/{id}/desc          编剧 / 集数 / 首播 / 每集
 *  4. .../rexxar/api/v2/movie/{id}/credits                  演职员英文名 latin_name（固定仅 8 条）
 *  5. movie.douban.com/subject/{id}/                        完整编剧 + IMDb（需登录态，失败静默）
 *  6. v3.sg.media-imdb.com/suggestion/{t|x}/{tt|片名}.json  IMDb 官方建议，免费无 key
 *  7. v3-cinemeta.strem.io/meta/{movie|series}/{tt}.json    IMDb 号直取剧情/演职员/类型/海报（免 key）
 *  8. movie.douban.com/j/subject_suggest?q=片名              按片名找条目
 *
 * 只有 IMDb 链接时：IMDb 建议 + Cinemeta 取片名 → 多写法搜豆瓣（年份/中文名/英文别名/类型打分）
 *   → 命中则走上述完整豆瓣链路；没命中就用 IMDb 数据直接拼一份简介，并列出豆瓣候选供手选。
 * 注意：suggestion/t/{tt}.json 是模糊搜索，返回结果里必须按 id 精确筛出目标那条。
 *
 * 已排除：frodo.douban.com App 接口（需授权 apiKey，实测 invalid_apikey）、
 *        rexxar .../credits 分页参数（无效，恒返 8 条）。
 */

(function () {
  'use strict';

  /* ======================== 环境兼容 ======================== */

  var gm = {
    get: function (k, d) {
      try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : d; } catch (e) { return d; }
    },
    set: function (k, v) {
      try { if (typeof GM_setValue === 'function') GM_setValue(k, v); } catch (e) { /* ignore */ }
    },
    copy: function (t) {
      try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(t, 'text'); return true; } } catch (e) { /* ignore */ }
      return false;
    },
    open: function (u) {
      try { if (typeof GM_openInTab === 'function') { GM_openInTab(u, { active: true }); return true; } } catch (e) { /* ignore */ }
      try { window.open(u, '_blank'); return true; } catch (e) { return false; }
    }
  };

  /* ======================== 版本与更新 ======================== */

  var SCRIPT_VERSION = '2.6.0';
  var UPDATE_URL = 'https://raw.githubusercontent.com/ljp801005-tech/douban-info-hdw/main/douban-pt-uploader.user.js';
  var CHECK_INTERVAL = 7 * 24 * 3600 * 1000;  // 每周检查一次

  /* ======================== 配置 ======================== */

  var CFG_KEY = 'dbpt_hdw_cfg_v2';
  var DEFAULTS = {
    template: 'cn',
    posterSource: 'auto',  // auto | imdb | douban | none
    rating: true,
    latin: true,
    imdb: true,
    linkStyle: 'bbcode',
    introWrap: 44,         // 简介每行字宽自动折行：0=不折行（中文按1、英文按0.5计宽）
    actorCount: 0,         // 主演显示条数：0=全部
    autoFromPage: true,    // 打开详情页时自动把页面上的豆瓣/IMDb 链接填进输入框（不发请求）
    customImdb: '',
    customWriters: '',
    lastUrl: '',
    lastCheck: 0,          // 上次检查更新的时间戳
    latestVersion: ''      // 上次检查发现的新版本号（空=无更新）
  };

  var cfg = loadCfg();
  var lastInfo = null, lastRaw = null, lastId = '', lastImdbBundle = null;

  function loadCfg() {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    var saved = gm.get(CFG_KEY, null);
    if (saved && typeof saved === 'object') {
      Object.keys(DEFAULTS).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(saved, k)) out[k] = saved[k];
      });
    }
    return out;
  }
  function saveCfg() { gm.set(CFG_KEY, cfg); }

  /* ======================== 网络 ======================== */

  function request(url, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8' };
    if (opts.referer) headers.Referer = opts.referer;
    if (opts.data) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    return new Promise(function (resolve) {
      function viaFetch() {
        try {
          fetch(url, { method: opts.method || 'GET', body: opts.data, headers: headers, credentials: 'include' })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(resolve)
            .catch(function () { resolve(null); });
        } catch (e) { resolve(null); }
      }
      if (typeof GM_xmlhttpRequest !== 'function') { viaFetch(); return; }
      try {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url: url,
          responseType: 'text',
          timeout: 15000,
          headers: headers,
          data: opts.data || undefined,
          onload: function (res) {
            if (res.status >= 200 && res.status < 300) resolve(String(res.response || ''));
            else resolve(null);
          },
          onerror: function () { resolve(null); },
          ontimeout: function () { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });
  }

  function parseJSON(t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }
  function isBlocked(t) {
    if (!t) return true;
    return /sec\.douban\.com|异常请求|安全验证|invalid_request_|请求过于频繁/.test(t);
  }

  var SUBJECT_URL = 'https://movie.douban.com/subject/{id}/';

  function fetchAll(id) {
    var subjectUrl = SUBJECT_URL.replace('{id}', id);
    var ref = 'https://m.douban.com/movie/subject/' + id + '/';
    var base = 'https://m.douban.com/rexxar/api/v2/movie/' + id;
    return Promise.all([
      request(base + '?for_mobile=1', { referer: ref }),
      request('https://api.douban.com/v2/movie/subject/' + id, {
        method: 'POST', data: 'apikey=0ab215a8b1977939201640fa14c66bab', referer: subjectUrl
      }),
      request('https://www.douban.com/doubanapp//h5/movie/' + id + '/desc', { referer: ref }),
      request(base + '/credits', { referer: ref }),
      request(subjectUrl, { referer: 'https://movie.douban.com/' }),
      request(base + '/celebrities', { referer: ref })
    ]).then(function (r) {
      return { rex: parseJSON(r[0]), v2: parseJSON(r[1]), h5: r[2], credits: parseJSON(r[3]), page: r[4], cele: parseJSON(r[5]) };
    });
  }

  function suggest(query) {
    return request('https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(query), {
      referer: 'https://movie.douban.com/'
    }).then(function (t) {
      var d = parseJSON(t);
      return Array.isArray(d) ? d.slice(0, 8) : [];
    });
  }

  /* ---------- 从当前种子详情页抓取豆瓣 / IMDb 链接 ---------- */

  function pageHtml() {
    try {
      var scope = document.querySelector('#torrent_info') ||
                  document.querySelector('.cblock-innercontent') ||
                  document.querySelector('#kdescr') ||
                  document.body;
      return scope ? String(scope.innerHTML || '') : '';
    } catch (e) { return ''; }
  }

  // 页面上的豆瓣条目：先找 a 标签，再兜底扫简介文本里出现的链接
  function pageDoubanId() {
    try {
      var as = document.querySelectorAll('a[href]');
      for (var i = 0; i < as.length; i++) {
        var m = String(as[i].getAttribute('href') || '').match(/douban\.com\/subject\/(\d+)/);
        if (m) return m[1];
      }
    } catch (e) { /* ignore */ }
    var m2 = pageHtml().match(/douban\.com\/(?:movie\/)?subject\/(\d+)/);
    return m2 ? m2[1] : '';
  }

  // 页面上的 IMDb 号（比按片名匹配更准）
  function imdbFromPage() {
    try {
      var as = document.querySelectorAll('a[href*="imdb.com/title/tt"]');
      for (var i = 0; i < as.length; i++) {
        var m = String(as[i].getAttribute('href') || '').match(/tt\d{6,10}/);
        if (m) return m[0];
      }
    } catch (e) { /* ignore */ }
    var html = pageHtml();
    var per = html.match(/imdb\.com\/title\/(tt\d{6,10})/i) || html.match(/\b(tt\d{6,10})\b/i);
    return per ? per[1].toLowerCase() : '';
  }

  // IMDb suggestion 的 t/ 接口其实是「按字符串模糊搜索」，d[0] 未必是目标影片，
  // 必须按 id 精确挑出目标那条，否则会拿错片名、反查到错误条目。
  function imdbMeta(tt) {
    return request('https://v3.sg.media-imdb.com/suggestion/t/' + tt + '.json', { referer: 'https://www.imdb.com/' })
      .then(function (t) {
        var d = parseJSON(t), arr = (d && Array.isArray(d.d)) ? d.d : [];
        var x = arr.filter(function (a) {
          return String((a && a.id) || '').toLowerCase() === String(tt).toLowerCase();
        })[0];
        if (!x) return null;
        return {
          id: x.id || tt, title: x.l || '', year: x.y || '', cast: x.s || '',
          imageUrl: (x.i && x.i.imageUrl) || '',
          isTv: /series|tv/i.test(String(x.qid || '') + String(x.q || ''))
        };
      }).catch(function () { return null; });
  }

  // Stremio Cinemeta 公共元数据（免 key）：片名/年份/剧情/导演/编剧/演员/类型/片长/海报/IMDb 评分
  // movie 与 series 两个端点都问一次，谁字段全用谁（剧集 series 端点才带分集）
  function cinemeta(tt) {
    var urls = [
      'https://v3-cinemeta.strem.io/meta/movie/' + tt + '.json',
      'https://v3-cinemeta.strem.io/meta/series/' + tt + '.json'
    ];
    return Promise.all(urls.map(function (u) { return request(u); })).then(function (rs) {
      var best = null;
      rs.forEach(function (t) {
        var d = parseJSON(t), m = d && d.meta;
        if (!m || !m.name) return;
        var score = (m.description ? 5 : 0) +
                    (Array.isArray(m.cast) ? Math.min(m.cast.length, 10) : 0) +
                    (Array.isArray(m.videos) ? 2 : 0) + (m.runtime ? 1 : 0);
        if (!best || score > best.score) best = { m: m, score: score };
      });
      return best ? best.m : null;
    }).catch(function () { return null; });
  }

  function imdbBundle(tt) {
    return Promise.all([imdbMeta(tt), cinemeta(tt)]).then(function (r) {
      return { im: r[0], cm: r[1] };
    });
  }

  // 一个 tt 号能拿到多个片名写法，逐个去豆瓣搜，命中率比只搜 IMDb 标题高得多
  function imdbQueries(im, cm) {
    var out = [], seen = {};
    function add(s) {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      if (s.length < 2 || seen[s.toLowerCase()]) return;
      seen[s.toLowerCase()] = 1; out.push(s);
    }
    if (im) {
      add(im.title);
      add(String(im.title || '').replace(/^(the|a|an)\s+/i, ''));
      var w = String(im.title || '').split(/\s+/);
      if (w.length > 4) add(w.slice(0, 3).join(' '));
    }
    if (cm) {
      add(cm.name);
      var slug = String(cm.slug || '').split('/').pop() || '';
      add(slug.replace(/-\d{4,}$/, '').replace(/-/g, ' '));
      add(String(cm.name || '').replace(/^(the|a|an)\s+/i, ''));
    }
    return out.slice(0, 5);
  }

  // 豆瓣 suggest 返回的是中文片名 + sub_title（往往是英文原名），两列都要比
  function imdbMatchScore(it, q, im, cm) {
    var s = 0;
    var title = String(it.title || '').toLowerCase();
    var sub = String(it.sub_title || '').toLowerCase();
    var yr = String((cm && cm.year) || (im && im.year) || '').match(/(19|20)\d{2}/);
    if (yr && String(it.year || '').indexOf(yr[0]) >= 0) s += 3;
    if (sub && sub === q) s += 4;
    else if (sub && (sub.indexOf(q) >= 0 || q.indexOf(sub) >= 0)) s += 2;
    if (title && title === q) s += 3;
    else if (title && (title.indexOf(q) >= 0 || q.indexOf(title) >= 0)) s += 2;
    var isTv = !!(cm && cm.type === 'series') || !!(cm && cm.videos && cm.videos.length) || !!(im && im.isTv);
    if ((String(it.type || '') === 'tv') === isTv) s += 1;
    return s;
  }

  // 返回 { best, items, bundle }：best 是可信的豆瓣条目，items 是供手选的候选
  function findDoubanByImdb(tt) {
    return imdbBundle(tt).then(function (bundle) {
      var qs = imdbQueries(bundle.im, bundle.cm);
      if (!qs.length) return { best: null, items: [], bundle: bundle };
      return Promise.all(qs.map(function (q) { return suggest(q); })).then(function (groups) {
        var seen = {}, items = [];
        groups.forEach(function (g) {
          (g || []).forEach(function (it) {
            if (it && it.id && !seen[it.id]) { seen[it.id] = 1; items.push(it); }
          });
        });
        items.forEach(function (it) {
          var sc = 0;
          qs.forEach(function (q) {
            sc = Math.max(sc, imdbMatchScore(it, q.toLowerCase(), bundle.im, bundle.cm));
          });
          it._score = sc;
        });
        items.sort(function (a, b) { return b._score - a._score; });
        return {
          best: (items.length && items[0]._score >= 5) ? items[0] : null,
          items: items, bundle: bundle
        };
      });
    }).catch(function () { return { best: null, items: [], bundle: { im: null, cm: null } }; });
  }

  // 豆瓣反查不到时，直接用 IMDb 数据拼一份完整 info，保证「有 IMDb 链接就能出简介」
  function imdbOnlyInfo(tt, bundle) {
    var im = bundle.im || {}, cm = bundle.cm || {};
    var title = String(im.title || cm.name || '').trim();
    var yr = String(cm.year || im.year || '').match(/(19|20)\d{2}/);
    function people(a) {
      return (Array.isArray(a) ? a : []).filter(Boolean).slice(0, 30).map(function (n) {
        return { name: String(n), latin: '' };
      });
    }
    var genres = Array.isArray(cm.genre) ? cm.genre : (Array.isArray(cm.genres) ? cm.genres : []);
    var poster = im.imageUrl ? imdbPosterUrl(im.imageUrl)
      : (cm.poster ? String(cm.poster).replace('/small/', '/medium/') : '');
    return {
      id: '', url: '', source: 'imdb',
      title: title, originalTitle: '', aka: [],
      year: yr ? yr[0] : String(im.year || ''),
      countries: cm.country ? String(cm.country).split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean) : [],
      genres: genres.slice(0, 5), languages: [],
      durations: cm.runtime ? [String(cm.runtime).replace(/(\d+)\s*min/i, '$1分钟')] : [],
      pubdate: cm.released ? [String(cm.released).slice(0, 10)] : [],
      episodes: (cm.videos && cm.videos.length) || 0,
      isTv: cm.type === 'series' || !!(cm.videos && cm.videos.length) || !!im.isTv,
      rating: { value: 0, count: 0 }, imdbRating: parseFloat(cm.imdbRating) || 0,
      intro: String(cm.description || '').trim(),
      poster: '', posterImdb: poster,
      directors: people(cm.director), writers: people(cm.writer), actors: people(cm.cast),
      imdb: tt, imdbUrl: 'https://www.imdb.com/title/' + tt + '/'
    };
  }

  // 海报兜底：豆瓣图床有 Referer 校验（站点 no-referrer 时 418），IMDb 图可自由外链
  function attachImdbPoster(info) {
    if (!info || !info.imdb || info.posterImdb) return;
    var src = cfg.posterSource || 'auto';
    if (src === 'none' || src === 'douban') return;
    imdbMeta(info.imdb).then(function (m) {
      if (!m || !m.imageUrl) return;
      info.posterImdb = imdbPosterUrl(m.imageUrl);
      if (lastInfo === info) regenerate();
    });
  }

  // 页面上既没豆瓣也没 IMDb 链接时的兜底：从种子标题猜片名
  function pageGuessTitle() {
    var raw = [];
    function push(t) { t = String(t || '').replace(/\s+/g, ' ').trim(); if (t) raw.push(t); }
    try {
      var h = document.querySelector('h1.title') || document.querySelector('#top') || document.querySelector('h1');
      if (h) push(h.textContent);
    } catch (e) { /* ignore */ }
    try {
      var as = document.querySelectorAll('a[href*="details.php?id="], a[href*="download.php"]');
      for (var i = 0; i < as.length && i < 3; i++) push(as[i].textContent);
    } catch (e) { /* ignore */ }
    var dt = String(document.title || '');
    var seg = dt.split(/\s*[-–—|]\s*/);
    if (seg.length > 1) push(seg[seg.length - 1]);
    push(dt);

    var seen = {};
    return raw.map(function (t) {
      return t.replace(/\[[^\]]*\]/g, ' ')
        .replace(/\bS\d{1,2}(E\d{1,3})?\b.*$/i, '')
        .replace(/\b(19|20)\d{2}\b.*$/, '')
        .replace(/\b(2160p|1080[pi]|720p|480p|WEB-?DL|WEBRip|BluRay|Blu-?ray|HDTV|REMUX|H\.?26[45]|HEVC|x26[45]|DDP?[\d.]|DTS|TrueHD|AAC|10bit|HDR)\b.*$/i, '')
        .replace(/[._]+/g, ' ')
        .replace(/\s*[-–—]\s*$/, '')
        .replace(/\s+/g, ' ').trim();
    }).filter(function (t) {
      if (!t || t.length < 2 || seen[t]) return false;
      seen[t] = 1; return true;
    });
  }

  // IMDb 官方搜索建议：免费无 key，中文片名也能通过拼音命中
  function fetchImdbId(info) {
    if (info.imdb) return Promise.resolve(info.imdb);
    var queries = [];
    if (info.originalTitle && /[A-Za-z]/.test(info.originalTitle)) queries.push(info.originalTitle);
    if (info.title && /[\u4e00-\u9fa5]/.test(info.title)) queries.push(info.title);
    info.aka.slice(0, 2).forEach(function (a) { if (/[A-Za-z]/.test(a)) queries.push(a); });

    return queries.reduce(function (p, q) {
      return p.then(function (found) { return found ? found : suggestImdb(q, info); });
    }, Promise.resolve(''));
  }

  function suggestImdb(q, info) {
    return request('https://v3.sg.media-imdb.com/suggestion/x/' + encodeURIComponent(q) + '.json', {
      referer: 'https://www.imdb.com/'
    }).then(function (t) {
      var d = parseJSON(t);
      if (!d || !Array.isArray(d.d)) return '';
      var latins = (info.actors || []).map(function (a) { return (a.latin || '').toLowerCase(); })
        .filter(Boolean);
      var best = '', bestScore = 0;
      d.d.forEach(function (x) {
        if (!x.id || !/^tt\d+$/.test(x.id)) return;
        var s = 0;
        if (info.year && String(x.y) === String(info.year)) s += 3;
        var isTvItem = /series|tv/i.test(String(x.q || '') + String(x.qid || ''));
        if (!!info.isTv === isTvItem) s += 2;
        var cast = String(x.s || '').toLowerCase();
        if (cast && latins.some(function (n) { return cast.indexOf(n) >= 0; })) s += 4;
        if (s > bestScore) { bestScore = s; best = x.id; }
      });
      return bestScore >= 3 ? best : '';
    }).catch(function () { return ''; });
  }

  /* ======================== 输入解析 ======================== */

  function parseInput(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    // IMDb：完整链接 / m.imdb.com / 裸 tt 号 / "IMDb: tt1234567" 文本都认
    var tt = s.match(/\b(tt\d{6,10})\b/i);
    if (tt && (/imdb/i.test(s) || /\/title\//i.test(s) || /^\s*tt\d{6,10}\s*$/i.test(s))) {
      return { imdb: tt[1].toLowerCase() };
    }
    var m = s.match(/subject\/(\d+)/) || s.match(/^\/?(\d{6,10})\/?$/) || s.match(/[?&]id=(\d+)/);
    if (m) return { id: m[1] };
    if (/imdb\.com/i.test(s)) return { error: '这个 IMDb 链接里没有 tt 编号，请复制影片页地址，形如 imdb.com/title/tt1234567/' };
    if (/^https?:\/\//i.test(s)) return { error: '这个链接里没有豆瓣条目 ID，需要 movie.douban.com/subject/数字/ 形式' };
    return { query: s };
  }

  /* ======================== 归一化 ======================== */

  function names(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      if (typeof x === 'string') return { name: x, latin: '' };
      if (x && x.name) return { name: x.name, latin: x.latin_name || '' };
      return null;
    }).filter(Boolean);
  }
  function list(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(function (x) { return x && typeof x !== 'object'; }).map(String);
  }
  function splitSlash(s) {
    return String(s || '').split(/\s*\/\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function splitPersons(s) {
    return splitSlash(s).map(function (x) {
      var m = x.match(/^(.+?)\s+([A-Za-z][A-Za-z.'\-\s]+)$/);
      return m ? { name: m[1].trim(), latin: m[2].trim() } : { name: x, latin: '' };
    });
  }
  function bigPoster(url) {
    if (!url) return '';
    return url.replace(/[sm]_ratio_poster/g, 'l_ratio_poster')
              .replace(/\/view\/photo\/[a-z]+\//, '/view/photo/l_ratio_poster/')
              .replace(/img\d+\.doubanio/, 'img9.doubanio');
  }

  function parseH5(html) {
    var out = {};
    if (!html || isBlocked(html)) return out;
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      Array.prototype.forEach.call(doc.querySelectorAll('section.subject-desc tr'), function (tr) {
        var td = tr.querySelectorAll('td');
        if (td.length >= 2) out[td[0].textContent.trim()] = td[1].textContent.trim();
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function parseSubjectPage(html) {
    var out = { attrs: {}, persons: {} };
    if (!html || isBlocked(html)) return out;
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var info = doc.querySelector('#info');
      if (info) {
        var tmp = document.createElement('div');
        tmp.innerHTML = info.innerHTML.replace(/<br\s*\/?>/gi, '\n');
        (tmp.textContent || '').split(/\n/).forEach(function (line) {
          var m = line.trim().match(/^([^:：]{1,12})[:：]\s*(.+)$/);
          if (m) out.attrs[m[1].trim()] = m[2].trim();
        });
        ['导演', '编剧', '主演'].forEach(function (k) {
          if (out.attrs[k]) out.persons[k] = splitPersons(out.attrs[k]);
        });
      }
      var ld = doc.querySelector('head > script[type="application/ld+json"]');
      if (ld) {
        var j = parseJSON(ld.textContent);
        if (j && j.aggregateRating) {
          out.rating = {
            value: parseFloat(j.aggregateRating.ratingValue) || 0,
            count: parseInt(j.aggregateRating.ratingCount, 10) || 0
          };
        }
        if (j && j.description) out.intro = String(j.description).trim();
      }
      var im = html.match(/tt\d{6,10}/);
      if (im) out.imdb = im[0];
    } catch (e) { /* ignore */ }
    return out;
  }

  function normalizeAll(id, raw) {
    var rex = raw.rex || {}, v2 = raw.v2 || {};
    var h5 = parseH5(raw.h5), page = parseSubjectPage(raw.page);
    var cred = raw.credits && Array.isArray(raw.credits.items) ? raw.credits.items : [];

    var info = {
      id: id, url: SUBJECT_URL.replace('{id}', id),
      title: '', originalTitle: '', aka: [], year: '',
      countries: [], genres: [], languages: [], durations: [], pubdate: [],
      episodes: 0, isTv: false, rating: { value: 0, count: 0 },
      intro: '', poster: '', posterImdb: '', directors: [], writers: [], actors: [], imdb: '', imdbUrl: ''
    };

    if (v2.title) {
      info.title = v2.title;
      info.originalTitle = v2.original_title || '';
      info.aka = list(v2.aka);
      info.year = v2.year || '';
      info.countries = list(v2.countries);
      info.genres = list(v2.genres);
      info.intro = v2.summary || '';
      info.rating = {
        value: parseFloat(v2.rating && v2.rating.average) || 0,
        count: parseInt(v2.ratings_count, 10) || 0
      };
      info.directors = names(v2.directors);
      info.actors = names(v2.casts);
      info.poster = bigPoster(v2.images && v2.images.large || '');
      info.episodes = parseInt(v2.episodes_count, 10) || 0;
      info.isTv = v2.subtype === 'tv';
    }

    if (rex.title) {
      info.title = rex.title;
      info.originalTitle = rex.original_title || '';
      info.aka = list(rex.aka);
      info.year = rex.year || '';
      info.countries = list(rex.countries);
      info.genres = list(rex.genres);
      info.languages = list(rex.languages);
      info.durations = list(rex.durations);
      info.pubdate = list(rex.pubdate);
      info.episodes = parseInt(rex.episodes_count, 10) || 0;
      info.isTv = !!rex.is_tv || rex.subtype === 'tv' || info.episodes > 0;
      info.intro = rex.intro || '';
      info.poster = bigPoster(rex.cover_url || (rex.pic && rex.pic.large) || '') || info.poster;
      info.rating = {
        value: parseFloat(rex.rating && rex.rating.value) || 0,
        count: parseInt(rex.rating && rex.rating.count, 10) || 0
      };
      info.directors = names(rex.directors);
      info.actors = names(rex.actors);
    }

    if (h5['编剧']) info.writers = splitPersons(h5['编剧']);
    if (h5['每集']) info.durations = [h5['每集']];
    if (h5['集数']) info.episodes = parseInt(h5['集数'], 10) || info.episodes;
    if (h5['首播']) { info.pubdate = splitSlash(h5['首播']); info.isTv = true; }
    if (h5['上映日期'] || h5['上映']) info.pubdate = splitSlash(h5['上映日期'] || h5['上映']);
    if (h5['语言']) info.languages = splitSlash(h5['语言']);
    if (h5['地区']) info.countries = splitSlash(h5['地区']);
    if (h5['类型']) info.genres = splitSlash(h5['类型']);
    if (h5['片长']) info.durations = [h5['片长']];
    if (h5['又名']) info.aka = splitSlash(h5['又名']);
    if (h5['导演']) info.directors = splitPersons(h5['导演']);
    if (h5['主演'] && !cred.length) info.actors = splitPersons(h5['主演']);

    if (cred.length) {
      var byRole = { d: [], w: [], a: [] };
      cred.forEach(function (it) {
        var p = { name: it.name || '', latin: it.latin_name || '' };
        var c = String(it.character || '');
        if (/导演|Director/i.test(c)) byRole.d.push(p);
        else if (/编剧|Writer/i.test(c)) byRole.w.push(p);
        else if (/演员|Actor|Actress|主演/i.test(c)) byRole.a.push(p);
      });
      if (byRole.d.length) info.directors = byRole.d;
      if (byRole.w.length) info.writers = byRole.w;
      if (byRole.a.length) info.actors = byRole.a;
    }

    // celebrities 接口：演职员比 credits（固定 8 条）多得多，且带英文名，两者互补合并
    var cele = raw.cele || {};
    if (cele && (cele.actors || cele.directors)) {
      function toP(a) { return { name: a.name || '', latin: a.latin_name || '' }; }
      function mergeInto(list, add) {
        var seen = {};
        list.forEach(function (x) { seen[x.name] = 1; });
        add.forEach(function (x) {
          if (x.name && !seen[x.name]) { list.push(x); seen[x.name] = 1; }
        });
      }
      var cActs = (cele.actors || []).map(toP);
      var cDirs = (cele.directors || []).map(toP);
      if (cDirs.length) {
        if (info.directors.length) mergeInto(info.directors, cDirs);
        else info.directors = cDirs;
      }
      if (cActs.length) {
        if (info.actors.length) mergeInto(info.actors, cActs);
        else info.actors = cActs;
      }
    }

    if (page.persons['导演'] && page.persons['导演'].length) info.directors = page.persons['导演'];
    if (page.persons['编剧'] && page.persons['编剧'].length) info.writers = page.persons['编剧'];
    if (page.persons['主演'] && page.persons['主演'].length) info.actors = page.persons['主演'];
    if (page.imdb) info.imdb = page.imdb;
    if (page.rating && page.rating.value) info.rating = page.rating;
    if (page.intro && page.intro.length > info.intro.length) info.intro = page.intro;
    if (page.attrs['IMDb']) {
      var pm = String(page.attrs['IMDb']).match(/tt\d+/);
      if (pm) info.imdb = pm[0];
    }
    if (page.attrs['制片国家/地区']) info.countries = splitSlash(page.attrs['制片国家/地区']);
    if (page.attrs['语言']) info.languages = splitSlash(page.attrs['语言']);
    if (page.attrs['又名']) info.aka = splitSlash(page.attrs['又名']);
    if (page.attrs['单集片长']) info.durations = [page.attrs['单集片长']];
    if (page.attrs['片长']) info.durations = [page.attrs['片长']];
    if (page.attrs['集数']) info.episodes = parseInt(page.attrs['集数'], 10) || info.episodes;
    if (page.attrs['首播']) { info.pubdate = splitSlash(page.attrs['首播']); info.isTv = true; }

    // 手填 IMDb
    var manual = String(cfg.customImdb || '').trim();
    if (manual) {
      var mm = manual.match(/tt\d{6,10}/);
      if (mm) info.imdb = mm[0];
      if (/^https?:/.test(manual)) info.imdbUrl = manual;
    }
    // 手填编剧补全
    var extra = String(cfg.customWriters || '').trim();
    if (extra) {
      var seen = {};
      info.writers.forEach(function (p) { seen[p.name] = 1; });
      splitPersons(extra).forEach(function (p) {
        if (p.name && !seen[p.name]) { seen[p.name] = 1; info.writers.push(p); }
      });
    }

    return info;
  }

  /* ======================== 模板 ======================== */

  function join(arr, sep) { return (arr || []).filter(Boolean).join(sep || ' / '); }
  function persons(arr, c, sep) {
    return (arr || []).map(function (p) {
      return c.latin && p.latin ? p.name + ' ' + p.latin : p.name;
    }).filter(Boolean).join(sep || ' / ');
  }
  function tag(label, value) {
    var ch = Array.from(label);
    if (ch.length === 2) return '◎' + ch[0] + '　　' + ch[1] + '　' + value;
    return '◎' + label + '　' + value;
  }
  function linkText(url, style) {
    if (style === 'none' || !url) return '';
    return style === 'plain' ? url : '[url=' + url + ']' + url + '[/url]';
  }
  function imdbValue(info) { return info.imdb ? (info.imdbUrl || 'https://www.imdb.com/title/' + info.imdb + '/') : ''; }
  function ratingText(info, c) {
    if (!c.rating || !info.rating || !info.rating.value) return '';
    return info.rating.value.toFixed(1) + '/10 (' + (info.rating.count || 0).toLocaleString('en-US') + '人评价)';
  }
  // IMDb 图片支持尺寸参数，统一压到 400 宽，加载快且不占版面
  function imdbPosterUrl(u) {
    if (!u) return '';
    var s = String(u);
    if (/\._V1/.test(s)) return s.replace(/\._V1.*$/, '._V1_SX400.jpg');
    return s.replace(/\.(jpe?g)$/i, '._V1_SX400$&');
  }
  // 豆瓣图床 img*.doubanio.com 有 Referer 校验，站点带 no-referrer 时必 418；IMDb 图无此限制
  function posterUrl(info, c) {
    var src = c.posterSource || 'auto';
    if (src === 'none') return '';
    return src === 'douban' ? (info.poster || '') : (info.posterImdb || info.poster || '');
  }
  function posterLine(info, c) {
    var u = posterUrl(info, c);
    return u ? '[img]' + u + '[/img]' : '';
  }
  function titlePair(info) {
    var hasOriginal = info.originalTitle && info.originalTitle !== info.title;
    return { film: hasOriginal ? info.originalTitle : info.title, trans: hasOriginal ? info.title : join(info.aka) };
  }
  function dateLabel(info) { return info.isTv ? '首播' : '上映日期'; }

  function buildCN(info, c) {
    var L = [], p = posterLine(info, c);
    if (p) L.push(p, '');
    var pair = titlePair(info);
    L.push(tag('片名', pair.film));
    if (pair.trans) L.push(tag('译名', pair.trans));
    if (info.year) L.push(tag('年代', info.year));
    if (info.countries.length) L.push(tag('产地', join(info.countries)));
    if (info.genres.length) L.push(tag('类别', join(info.genres)));
    if (info.languages.length) L.push(tag('语言', join(info.languages)));
    if (info.pubdate.length) L.push(tag(dateLabel(info), join(info.pubdate)));
    var dl = linkText(info.url, c.linkStyle);
    if (dl) L.push(tag('豆瓣链接', dl));
    var rt = ratingText(info, c);
    if (rt) L.push(tag('豆瓣评分', rt));
    if (c.rating && info.imdbRating && !rt) L.push(tag('IMDb评分', info.imdbRating.toFixed(1) + '/10'));
    if ((c.imdb || info.source === 'imdb') && imdbValue(info))
      L.push(tag('IMDb', linkText(imdbValue(info), c.linkStyle === 'none' ? 'plain' : c.linkStyle)));
    if (info.isTv && info.episodes) L.push(tag('集数', String(info.episodes)));
    if (info.durations.length) L.push(tag('片长', join(info.durations)));
    if (info.directors.length) L.push(tag('导演', persons(info.directors, c)));
    if (info.writers.length) L.push(tag('编剧', persons(info.writers, c)));
    if (info.actors.length) {
      var f = info.actors[0];
      L.push(tag('主演', c.latin && f.latin ? f.name + ' ' + f.latin : f.name));
      info.actors.slice(1).forEach(function (a) {
        L.push(c.latin && a.latin ? a.name + ' ' + a.latin : a.name);
      });
    }
    if (info.intro) {
      L.push('◎简　　介');
      info.intro.split(/\n/).forEach(function (line) { L.push(line.trim()); });
    }
    return L.join('\n');
  }

  function fieldsEN(info, c) {
    var pair = titlePair(info);
    var f = [
      ['Title', pair.film], ['Chinese Title', pair.trans], ['Year', info.year],
      ['Country', join(info.countries)], ['Genre', join(info.genres)], ['Language', join(info.languages)],
      [info.isTv ? 'Release' : 'Release Date', join(info.pubdate)],
      ['Episodes', info.isTv && info.episodes ? String(info.episodes) : ''],
      ['Runtime', join(info.durations)],
      ['Director', persons(info.directors, c)], ['Writer', persons(info.writers, c)],
      ['Cast', persons(info.actors, c)]
    ];
    var rt = ratingText(info, c);
    if (rt) f.push(['Douban Rating', rt]);
    if (c.rating && info.imdbRating && !rt) f.push(['IMDb Rating', info.imdbRating.toFixed(1) + '/10']);
    if ((c.imdb || info.source === 'imdb') && imdbValue(info)) f.push(['IMDb', imdbValue(info)]);
    if (c.linkStyle !== 'none' && info.url) f.push(['Douban', info.url]);
    return f.filter(function (x) { return x[1]; });
  }

  function buildBBCode(info, c) {
    var L = [], p = posterLine(info, c);
    if (p) L.push(p, '');
    fieldsEN(info, c).forEach(function (f) {
      L.push('[b]' + f[0] + ':[/b] ' + (/^https?:/.test(f[1]) ? linkText(f[1], c.linkStyle) : f[1]));
    });
    if (info.intro) L.push('', '[b]Plot:[/b]', '[quote]' + info.intro.trim() + '[/quote]');
    return L.join('\n');
  }

  function buildMarkdown(info, c) {
    var L = [];
    var mu = posterUrl(info, c);
    if (mu) L.push('![](' + mu + ')', '');
    fieldsEN(info, c).forEach(function (f) {
      L.push('**' + f[0] + ':** ' + (/^https?:/.test(f[1]) && c.linkStyle !== 'none' ? '[' + f[1] + '](' + f[1] + ')' : f[1]));
    });
    if (info.intro) {
      L.push('', '**Plot:**', '');
      info.intro.split(/\n/).forEach(function (line) { L.push('> ' + line.trim()); });
    }
    return L.join('\n');
  }

  function buildPlain(info, c) {
    var L = [];
    var pu = posterUrl(info, c);
    if (pu) L.push(pu, '');
    fieldsEN(info, c).forEach(function (f) { L.push(f[0] + ': ' + f[1]); });
    if (info.intro) L.push('', 'Plot:', info.intro.trim());
    return L.join('\n');
  }

  // 简介按字宽折行：中文全角计 1，英文半角计 0.5；BBCode 标签、URL、连续英文词不拆断
  function wrapIntroText(text, width) {
    if (!text || !width) return text || '';
    var out = [];
    String(text).split(/\n/).forEach(function (para) {
      var line = para.trim();
      if (!line) { out.push(''); return; }
      if (line.length * 0.5 <= width) { out.push(line); return; }  // 半角计宽都放得下，必然不用折
      var toks = line.match(/\[[^\]\n]*\]|https?:\/\/[^\s\]]+|[A-Za-z0-9][A-Za-z0-9'\u00b7\.\-_/]*|\s+|[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]|./g) || [line];
      var cur = '', curW = 0;
      function w(t) {
        var n = 0;
        for (var i = 0; i < t.length; i++) {
          var c = t.charCodeAt(i);
          n += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) ? 1 : 0.5;
        }
        return n;
      }
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (/^\s+$/.test(t)) { cur += ' '; continue; }  // 行尾空格最后会 trim
        var tw = w(t);
        if (curW + tw > width && cur.trim()) {
          out.push(cur.trim());
          cur = ''; curW = 0;
        }
        cur += t; curW += tw;
        if (/^[\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u201d\u2019\u300b\uff09]/.test(t) && curW >= width - 1 && i < toks.length - 1) {
          // 标点在行末且接近宽度，顺手断行
        }
      }
      if (cur.trim()) out.push(cur.trim());
    });
    return out.join('\n');
  }

  function buildDescription(info, c) {
    // 主演数量控制：0=全部
    if (c.actorCount > 0 && info.actors && info.actors.length > c.actorCount) {
      info = Object.assign({}, info, { actors: info.actors.slice(0, c.actorCount) });
    }
    // 简介折行：0=不折行
    if (c.introWrap > 0 && info.intro) {
      info = Object.assign({}, info, { intro: wrapIntroText(info.intro, c.introWrap) });
    }
    if (c.template === 'bbcode') return buildBBCode(info, c);
    if (c.template === 'markdown') return buildMarkdown(info, c);
    if (c.template === 'plain') return buildPlain(info, c);
    return buildCN(info, c);
  }

  /* ======================== 更新检测 ======================== */

  var updateInfo = null;  // { version: 'x.y.z' }

  // 逐段数字比较：a > b 返回 true
  function isNewer(a, b) {
    var pa = String(a || '').split('.'), pb = String(b || '').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  // 每周一次拉取仓库里的脚本头部 @version 做比对（force=手动立即检查）
  function checkUpdate(force) {
    var now = Date.now();
    if (!force && cfg.lastCheck && now - cfg.lastCheck < CHECK_INTERVAL) return;
    cfg.lastCheck = now;
    saveCfg();
    request(UPDATE_URL).then(function (t) {
      if (!t) {
        if (force) status('检查更新失败：无法访问 GitHub，稍后再试', 'err');
        return;
      }
      var m = String(t).match(/@version\s+([\d.]+)/);
      if (m && isNewer(m[1], SCRIPT_VERSION)) {
        cfg.latestVersion = m[1];
        updateInfo = { version: m[1] };
      } else {
        cfg.latestVersion = '';
        updateInfo = null;
      }
      saveCfg();
      renderUpdateUI();
      if (force) {
        if (updateInfo) status('发现新版本 v' + updateInfo.version + '，点底部红字安装更新', 'ok');
        else status('已是最新版本 v' + SCRIPT_VERSION, 'ok');
      }
    });
  }

  // 有新版本：图标挂红点 + 底部出现红色更新入口
  function renderUpdateUI() {
    if (updateInfo && isNewer(updateInfo.version, SCRIPT_VERSION)) {
      if (ui.tab) {
        ui.tab.classList.add('upd');
        ui.tab.title = '发现新版本 v' + updateInfo.version + '，展开面板可安装更新';
      }
      if (ui.verLine) {
        ui.verLine.textContent = 'v' + SCRIPT_VERSION + '（有新版本 v' + updateInfo.version + '）';
      }
      if (ui.updLine) {
        ui.updLine.innerHTML = '';
        var a = el('a', '', '发现新版本 v' + updateInfo.version + ' → 点击安装更新');
        a.onclick = function () { gm.open(UPDATE_URL); };
        ui.updLine.appendChild(a);
        ui.updLine.classList.remove('hide');
      }
    } else {
      if (ui.tab) ui.tab.classList.remove('upd');
      if (ui.updLine) ui.updLine.classList.add('hide');
      if (ui.verLine) ui.verLine.textContent = 'v' + SCRIPT_VERSION + ' · 每周自动检查更新（点击立即检查）';
    }
  }

  /* ======================== UI ======================== */

  var host = null, root = null, ui = {}, dragged = false, expanded = false;
  var pinned = false, hoverTimer = 0, closeTimer = 0, suppressHover = 0;

  // 贴合 HDWing X2015 主题：蓝灰 #738ba8 / 亮蓝 #0083ff / 浅蓝灰 #b9c5d3
  var CSS = `
  :host{all:initial;position:fixed;inset:0 auto auto 0;width:0;height:0;
    z-index:2147483647;pointer-events:none;
    --brand:#0083ff; --brand-d:#006ad1;
    --slate:#738ba8; --slate-d:#5d7691;
    --db:#00b51d; --db-d:#008f16; --db-line:#00761a;
    --line:#cdd7e3; --line-2:#b9c5d3;
    --bg:#fbfcfd; --bg-2:#ffffff; --head:#f1f5f9;
    --text:#2f3a45; --muted:#6b7a89; --ok:#2e7d32; --err:#d9534f;
    /* 毛玻璃层：面板底 / 输入控件底 / 玻璃边框高光 */
    --glass:rgba(248,251,255,.78); --glass-2:rgba(255,255,255,.74);
    --glass-line:rgba(255,255,255,.72); --glass-shadow:rgba(20,48,80,.26);
    --hd-a:rgba(115,139,168,.88); --hd-b:rgba(93,118,145,.9);
    --radius:4px;}
  :host(.dark){
    --brand:#4aa8ff; --brand-d:#2f92f0;
    --slate:#3c4c5c; --slate-d:#31404e;
    --db:#1fbe3a; --db-d:#16a02e; --db-line:#0c7a20;
    --line:#3d4a57; --line-2:#4a5765;
    --bg:#1d252d; --bg-2:#232c35; --head:#2a343e;
    --text:#dfe6ed; --muted:#93a1ae; --ok:#67c47a; --err:#ff8a80;
    --glass:rgba(28,37,46,.72); --glass-2:rgba(35,44,53,.62);
    --glass-line:rgba(255,255,255,.16); --glass-shadow:rgba(0,0,0,.5);
    --hd-a:rgba(60,76,92,.88); --hd-b:rgba(49,64,78,.9);}
  *{box-sizing:border-box}
  .tab,.panel{pointer-events:auto}
  /* 收起态入口：只有一个「豆」，底色即状态
     灰蓝＝页面没取到链接　绿＝已取到链接　蓝＝读取中　红＝失败 */
  .tab{position:fixed;z-index:2147483647;left:0;top:96px;
    width:34px;height:34px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,var(--slate),var(--slate-d));
    border:1px solid var(--slate-d);border-left:0;border-radius:0 8px 8px 0;
    color:#fff;cursor:pointer;user-select:none;
    box-shadow:0 3px 10px rgba(0,0,0,.26),0 1px 0 rgba(255,255,255,.24) inset;
    transition:background .28s ease,border-color .28s ease,box-shadow .28s ease,transform .16s ease}
  .tab:hover{transform:translateX(2px)}
  .tab .ico{font:700 17px/1 "Microsoft YaHei","PingFang SC",sans-serif;letter-spacing:0;
    text-shadow:0 1px 2px rgba(0,0,0,.22)}
  /* 已取到链接 */
  .tab.ready{background:linear-gradient(135deg,var(--db),var(--db-d));border-color:var(--db-line);
    box-shadow:0 3px 12px rgba(0,120,25,.4),0 1px 0 rgba(255,255,255,.26) inset;
    animation:dbGlow 3.4s ease-in-out infinite}
  @keyframes dbGlow{
    0%,100%{box-shadow:0 3px 10px rgba(0,120,25,.32),0 1px 0 rgba(255,255,255,.24) inset}
    50%{box-shadow:0 3px 18px rgba(0,181,29,.62),0 1px 0 rgba(255,255,255,.3) inset}}
  /* 读取中 */
  .tab.busy{background:linear-gradient(135deg,var(--brand),var(--brand-d));border-color:var(--brand-d);
    animation:dbPulse 1.05s ease-in-out infinite}
  @keyframes dbPulse{
    0%,100%{box-shadow:0 3px 10px rgba(0,106,209,.34),0 1px 0 rgba(255,255,255,.24) inset}
    50%{box-shadow:0 3px 18px rgba(0,131,255,.7),0 1px 0 rgba(255,255,255,.3) inset}}
  /* 失败 / 未匹配 */
  .tab.fail{background:linear-gradient(135deg,#e2574f,#c0453f);border-color:#a83b36;
    box-shadow:0 3px 10px rgba(160,50,45,.4),0 1px 0 rgba(255,255,255,.22) inset}
  /* 有新版本：右上角红点 */
  .tab .dot{position:absolute;top:-4px;right:-4px;width:10px;height:10px;border-radius:50%;
    background:#ff4d4f;border:2px solid #fff;box-shadow:0 0 6px rgba(255,60,60,.85);
    display:none;animation:dbBlink 1.4s ease-in-out infinite}
  .tab.upd .dot{display:block}
  @keyframes dbBlink{0%,100%{opacity:1}50%{opacity:.35}}
  /* 毛玻璃面板：半透明底 + 背景模糊，透出站点内容又不失可读性 */
  .panel{position:fixed;z-index:2147483647;left:12px;top:96px;width:432px;max-width:calc(100vw - 24px);
    max-height:calc(100vh - 28px);
    display:flex;flex-direction:column;background:var(--glass);color:var(--text);
    -webkit-backdrop-filter:blur(18px) saturate(165%);
    backdrop-filter:blur(18px) saturate(165%);
    border:1px solid var(--glass-line);border-radius:var(--radius);
    box-shadow:0 8px 32px var(--glass-shadow),0 1px 0 rgba(255,255,255,.55) inset;overflow:hidden;
    font:12px/1.55 "Microsoft YaHei","PingFang SC",Tahoma,Verdana,sans-serif;
    opacity:0;transform:translateY(-6px);pointer-events:none;transition:opacity .16s,transform .16s}
  /* 不支持 backdrop-filter 的浏览器：退回纯色，保证文字对比度 */
  @supports not ((backdrop-filter:blur(2px)) or (-webkit-backdrop-filter:blur(2px))){
    .panel{background:var(--bg);border-color:var(--line-2)}
    .bd{background:var(--bg)}
    input[type=text],select,textarea,.cand{background:var(--bg-2)}
    .btn.sec{background:linear-gradient(180deg,var(--bg-2),var(--head))}
    .hd{background:linear-gradient(180deg,var(--slate),var(--slate-d))}
  }
  .panel.on{opacity:1;transform:none;pointer-events:auto}
  .hd{display:flex;align-items:center;gap:6px;padding:0 8px;height:32px;
    background:linear-gradient(180deg,var(--hd-a),var(--hd-b));
    -webkit-backdrop-filter:blur(12px) saturate(150%);
    backdrop-filter:blur(12px) saturate(150%);
    color:#fff;cursor:move;user-select:none}
  .hd .ttl{flex:1;font-weight:600;font-size:12px;letter-spacing:.3px}
  .hd .tagx{font-size:10px;font-weight:400;opacity:.75;margin-right:2px}
  .hd button{width:20px;height:20px;line-height:18px;text-align:center;background:rgba(255,255,255,.14);
    border:1px solid rgba(255,255,255,.22);border-radius:3px;color:#fff;font-size:13px;cursor:pointer;padding:0}
  .hd button:hover{background:rgba(255,255,255,.3)}
  .bd{padding:10px;display:flex;flex-direction:column;gap:8px;background:transparent;overflow:auto}
  .row{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
  .lb{color:var(--muted);font-size:11px;min-width:52px}
  input[type=text],select,textarea{font:inherit;color:var(--text);background:var(--glass-2);
    border:1px solid var(--line);border-radius:3px;padding:5px 7px;outline:none;box-shadow:inset 0 1px 2px rgba(0,0,0,.04)}
  input[type=text]:focus,select:focus,textarea:focus{border-color:var(--brand);box-shadow:0 0 0 2px rgba(0,131,255,.15)}
  input[type=text]{flex:1;min-width:120px}
  select{max-width:186px;font-size:11.5px;padding:4px 6px}
  .btn{font:inherit;background:linear-gradient(180deg,var(--brand),var(--brand-d));color:#fff;border:1px solid var(--brand-d);
    border-radius:3px;padding:5px 11px;cursor:pointer;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.15)}
  .btn:hover{filter:brightness(1.07)}
  .btn:active{transform:translateY(1px)}
  .btn.sec{background:var(--glass-2);color:var(--text);border-color:var(--line);box-shadow:none}
  .btn.sec:hover{background:var(--head)}
  .btn[disabled]{opacity:.5;filter:grayscale(.55) saturate(.35);cursor:not-allowed}
  .opts{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--text);padding:1px 0}
  .opts label{display:flex;align-items:center;gap:3px;cursor:pointer}
  .opts input{margin:0;vertical-align:-1px}
  textarea.pv{width:100%;height:196px;resize:vertical;font:11.5px/1.5 Consolas,Menlo,Monaco,"Courier New",monospace;
    white-space:pre;tab-size:2;background:var(--glass-2)}
  .st{font-size:11px;color:var(--muted);min-height:16px;word-break:break-all;line-height:1.45}
  .st.ok{color:var(--ok)}.st.err{color:var(--err)}
  .cand{display:flex;flex-direction:column;max-height:132px;overflow:auto;border:1px solid var(--line);
    border-radius:3px;background:var(--glass-2);padding:2px}
  .cand a{font-size:11.5px;color:var(--brand);cursor:pointer;padding:3px 5px;text-decoration:none;border-radius:2px}
  .cand a:hover{background:var(--head)}
  .hide{display:none!important}
  .foot{font-size:10.5px;color:var(--muted);border-top:1px dotted var(--line);padding-top:6px;line-height:1.5}
  .foot .ver{cursor:pointer}
  .foot .ver:hover{color:var(--brand)}
  .foot .upd a{color:var(--err);font-weight:600;cursor:pointer;text-decoration:none}
  .foot .upd a:hover{text-decoration:underline}
  `;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function topOffset() {
    var hdr = document.querySelector('#site_header') || document.querySelector('.headerbox') || document.querySelector('#header');
    var bottom = hdr ? hdr.getBoundingClientRect().bottom : 0;
    return Math.max(10, Math.round(bottom) + 10);
  }

  function pageIsDark() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor;
      var m = String(bg).match(/[\d.]+/g);
      if (!m || m.length < 3) return false;
      return (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) < 120;
    } catch (e) { return false; }
  }

  function buildUI() {
    host = document.createElement('div');
    host.setAttribute('data-dbpt', '1');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    (document.body || document.documentElement).appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    if (pageIsDark()) host.classList.add('dark');

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    // 收起态：左上角醒目入口（悬停自动展开）
    ui.tab = el('div', 'tab');
    ui.tab.appendChild(el('span', 'ico', '豆'));
    ui.dot = el('span', 'dot');           // 新版本红点
    ui.tab.appendChild(ui.dot);
    ui.tab.title = '豆瓣简介 · 待粘贴链接（悬停或点击展开）';
    ui.tab.onclick = function () { pinned = true; setExpanded(true); };
    ui.tab.onmouseenter = function () {
      if (Date.now() < suppressHover) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () { if (!expanded) setExpanded(true, true); }, 110);
    };
    ui.tab.onmouseleave = function () { clearTimeout(hoverTimer); scheduleClose(); };
    root.appendChild(ui.tab);

    // 展开态：面板
    var panel = el('div', 'panel');
    ui.panel = panel;
    panel.onmouseenter = function () { clearTimeout(hoverTimer); clearTimeout(closeTimer); };
    panel.onmouseleave = function () { clearTimeout(hoverTimer); scheduleClose(); };
    // 在面板内操作过就钉住，鼠标移开不再自动收，避免填到一半被收走
    panel.addEventListener('mousedown', function () { pinned = true; });
    panel.addEventListener('focusin', function () { pinned = true; });
    root.appendChild(panel);

    var hd = el('div', 'hd');
    hd.appendChild(el('span', 'ttl', '豆瓣简介'));
    hd.appendChild(el('span', 'tagx', 'HDWing · v' + SCRIPT_VERSION));
    var bMin = el('button', '', '—'); bMin.title = '收起';
    bMin.onclick = function () { setExpanded(false); };
    var bClose = el('button', '', '×'); bClose.title = '收起';
    bClose.onclick = function () { setExpanded(false); };
    hd.appendChild(bMin); hd.appendChild(bClose);
    panel.appendChild(hd);
    makeDraggable(hd, panel);

    var bd = el('div', 'bd');
    panel.appendChild(bd);

    var r1 = el('div', 'row');
    ui.url = document.createElement('input');
    ui.url.type = 'text';
    ui.url.placeholder = '粘贴豆瓣 / IMDb 链接、条目 ID 或片名';
    ui.url.value = '';
    ui.url.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); runGenerate(); } };
    r1.appendChild(ui.url);
    var bGo = el('button', 'btn', '生成');
    bGo.onclick = runGenerate;
    r1.appendChild(bGo);
    bd.appendChild(r1);

    ui.cand = el('div', 'cand hide');
    bd.appendChild(ui.cand);

    var r2 = el('div', 'row');
    r2.appendChild(el('span', 'lb', '模板'));
    ui.tpl = document.createElement('select');
    [['cn', '中文 ◎ 格式'], ['bbcode', '英文 BBCode'], ['markdown', 'Markdown'], ['plain', '纯文本']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; ui.tpl.appendChild(op);
    });
    ui.tpl.value = cfg.template;
    ui.tpl.onchange = function () { cfg.template = ui.tpl.value; saveCfg(); regenerate(); };
    r2.appendChild(ui.tpl);

    ui.linkWrap = el('span', 'row');
    ui.linkWrap.appendChild(el('span', 'lb', '链接'));
    ui.linkStyle = document.createElement('select');
    ui.linkStyle.style.cssText = 'max-width:96px';
    [['bbcode', 'BBCode'], ['plain', '纯链接'], ['none', '不显示']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; ui.linkStyle.appendChild(op);
    });
    ui.linkStyle.value = cfg.linkStyle;
    ui.linkStyle.onchange = function () { cfg.linkStyle = ui.linkStyle.value; saveCfg(); regenerate(); };
    ui.linkWrap.appendChild(ui.linkStyle);
    r2.appendChild(ui.linkWrap);

    ui.actorWrap = el('span', 'row');
    ui.actorWrap.appendChild(el('span', 'lb', '主演'));
    ui.actorCount = document.createElement('select');
    ui.actorCount.style.cssText = 'max-width:84px';
    [[0, '全部'], [15, '15人'], [10, '10人'], [5, '5人']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; ui.actorCount.appendChild(op);
    });
    ui.actorCount.value = String(cfg.actorCount || 0);
    ui.actorCount.onchange = function () { cfg.actorCount = parseInt(ui.actorCount.value, 10) || 0; saveCfg(); regenerate(); };
    ui.actorWrap.appendChild(ui.actorCount);
    r2.appendChild(ui.actorWrap);

    ui.wrapWrap = el('span', 'row');
    ui.wrapWrap.appendChild(el('span', 'lb', '折行'));
    ui.introWrap = document.createElement('select');
    ui.introWrap.style.cssText = 'max-width:76px';
    [[0, '不折'], [36, '36字'], [44, '44字'], [52, '52字']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; ui.introWrap.appendChild(op);
    });
    ui.introWrap.value = String(cfg.introWrap == null ? 44 : cfg.introWrap);
    ui.introWrap.onchange = function () { cfg.introWrap = parseInt(ui.introWrap.value, 10) || 0; saveCfg(); regenerate(); };
    ui.wrapWrap.appendChild(ui.introWrap);
    r2.appendChild(ui.wrapWrap);
    bd.appendChild(r2);

    var r3 = el('div', 'opts');
    ui.checks = {};
    [['rating', '评分'], ['latin', '英文名'], ['imdb', 'IMDb'], ['autoFromPage', '自动取链']].forEach(function (o) {
      var l = el('label');
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!cfg[o[0]];
      cb.onchange = function () { cfg[o[0]] = cb.checked; saveCfg(); regenerate(); };
      ui.checks[o[0]] = cb;
      l.appendChild(cb); l.appendChild(document.createTextNode(o[1]));
      r3.appendChild(l);
    });
    bd.appendChild(r3);

    var rp = el('div', 'row');
    rp.appendChild(el('span', 'lb', '海报'));
    ui.posterSource = document.createElement('select');
    ui.posterSource.style.cssText = 'flex:0 1 auto;max-width:none;min-width:158px';
    [['auto', '自动（优先 IMDb）'], ['imdb', '仅 IMDb 图'], ['douban', '仅豆瓣图'], ['none', '不显示海报']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; ui.posterSource.appendChild(op);
    });
    ui.posterSource.value = cfg.posterSource || 'auto';
    ui.posterSource.onchange = function () {
      cfg.posterSource = ui.posterSource.value;
      saveCfg();
      if (!lastInfo) return;
      if (cfg.posterSource !== 'douban' && !lastInfo.posterImdb) attachImdbPoster(lastInfo);
      regenerate();
    };
    rp.appendChild(ui.posterSource);
    bd.appendChild(rp);

    var r4 = el('div', 'row');
    r4.appendChild(el('span', 'lb', 'IMDb'));
    ui.imdb = document.createElement('input');
    ui.imdb.type = 'text';
    ui.imdb.placeholder = 'tt1234567（留空自动匹配）';
    ui.imdb.value = cfg.customImdb || '';
    ui.imdb.onchange = function () { cfg.customImdb = ui.imdb.value.trim(); saveCfg(); applyOverrides(); };
    r4.appendChild(ui.imdb);
    bd.appendChild(r4);

    var r4b = el('div', 'row');
    r4b.appendChild(el('span', 'lb', '编剧补全'));
    ui.writers = document.createElement('input');
    ui.writers.type = 'text';
    ui.writers.placeholder = '徐頔 Di Xu / 孔二狗 Ergou Kong';
    ui.writers.value = cfg.customWriters || '';
    ui.writers.onchange = function () { cfg.customWriters = ui.writers.value.trim(); saveCfg(); applyOverrides(); };
    r4b.appendChild(ui.writers);
    bd.appendChild(r4b);

    ui.preview = document.createElement('textarea');
    ui.preview.className = 'pv';
    ui.preview.placeholder = '生成的简介会显示在这里，可直接修改…';
    bd.appendChild(ui.preview);

    var r5 = el('div', 'row');
    ui.bCopy = el('button', 'btn', '复制简介'); ui.bCopy.onclick = copy;
    ui.bOpen = el('button', 'btn sec', '打开豆瓣');
    ui.bOpen.onclick = function () { pinned = false; openDouban(); };
    [ui.bCopy, ui.bOpen].forEach(function (b) { r5.appendChild(b); });
    bd.appendChild(r5);

    ui.status = el('div', 'st', '粘贴豆瓣 / IMDb 链接后点「生成」（Enter）');
    bd.appendChild(ui.status);

    // 底部：版本号 + 新版本更新入口
    var foot = el('div', 'foot');
    ui.verLine = el('div', 'ver', 'v' + SCRIPT_VERSION + ' · 每周自动检查更新（点击立即检查）');
    ui.verLine.title = '立即检查一次新版本';
    ui.verLine.onclick = function () { status('正在检查更新…'); checkUpdate(true); };
    ui.updLine = el('div', 'upd hide');
    foot.appendChild(ui.verLine);
    foot.appendChild(ui.updLine);
    foot.appendChild(el('div', '', '只自动填链接、点「生成」才请求；没有豆瓣链接时，粘贴 IMDb 链接也能生成简介（先反查豆瓣，匹配不到就用 IMDb 数据）。'));
    bd.appendChild(foot);

    document.addEventListener('keydown', function (e) {
      if (!expanded) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runGenerate(); }
      if (e.key === 'Escape') setExpanded(false);
    });

    positionWidgets();
    window.addEventListener('resize', function () { if (!dragged) positionWidgets(); });
  }

  function positionWidgets() {
    var top = topOffset();
    // 顶部若有固定/吸顶的公告条压在这里，就逐档下移到它下面，避免图标被盖
    for (var i = 0; i < 4; i++) {
      var stack = [];
      try { stack = document.elementsFromPoint(8, top + 12) || []; } catch (e) { stack = []; }
      var blocked = false;
      for (var k = 0; k < stack.length; k++) {
        if (stack[k] === host || stack[k] === document.body || stack[k] === document.documentElement) continue;
        var st = null;
        try { st = getComputedStyle(stack[k]); } catch (e) { st = null; }
        if (st && (st.position === 'fixed' || st.position === 'sticky') &&
            st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.1) { blocked = true; break; }
      }
      if (!blocked) break;
      top += 48;
    }
    ui.tab.style.top = top + 'px';
    if (!dragged) ui.panel.style.top = top + 'px';
  }

  function setExpanded(on, noFocus) {
    expanded = !!on;
    if (on) {
      clearTimeout(closeTimer);
      ui.tab.classList.add('hide');
      ui.panel.classList.add('on');
      if (!noFocus) { ui.url.focus(); ui.url.select(); }
    } else {
      pinned = false;
      clearTimeout(hoverTimer);
      clearTimeout(closeTimer);
      ui.panel.classList.remove('on');
      ui.tab.classList.remove('hide');
      suppressHover = Date.now() + 420;  // 刚收起时鼠标还在原位，别立刻又弹开
    }
  }

  // 悬停移开后延迟收起；鼠标仍在面板/标签上就再等等
  function scheduleClose() {
    if (!expanded || pinned) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      if (!expanded || pinned) return;
      try {
        if (ui.panel.matches(':hover') || ui.tab.matches(':hover')) return;
      } catch (e) { /* ignore */ }
      setExpanded(false);
    }, 420);
  }

  // kind: '' 灰（没取到链接）/ 'ready' 绿（已取到）/ 'busy' 蓝（读取中）/ 'fail' 红（失败）
  function setTabState(kind, text, tip) {
    if (!ui.tab) return;
    ui.tab.classList.remove('ready', 'busy', 'fail');
    if (kind) ui.tab.classList.add(kind);
    var label = text || ({ ready: '已取到链接', busy: '读取中', fail: '未取到链接' }[kind] || '待粘贴链接');
    ui.tab.title = tip ? (label + ' · ' + tip) : label;
  }

  function makeDraggable(handle, panel) {
    var sx = 0, sy = 0, px = 0, py = 0, on = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      on = true; dragged = true;
      sx = e.clientX; sy = e.clientY;
      var r = panel.getBoundingClientRect();
      px = r.left; py = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!on) return;
      panel.style.left = Math.max(0, px + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, py + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', function () { on = false; });
  }

  function status(msg, kind) {
    if (!ui.status) return;
    ui.status.textContent = msg;
    ui.status.className = 'st' + (kind ? ' ' + kind : '');
  }

  function regenerate() {
    if (!lastInfo) return;
    ui.preview.value = buildDescription(lastInfo, cfg);
  }

  function applyOverrides() {
    // IMDb 直接生成的 info 没有 raw，手填项要在这里补
    if (lastInfo && lastInfo.source === 'imdb') {
      var manual = String(cfg.customImdb || '').trim(), mm = manual.match(/tt\d{6,10}/);
      if (mm) { lastInfo.imdb = mm[0]; lastInfo.imdbUrl = 'https://www.imdb.com/title/' + mm[0] + '/'; }
      var extra = String(cfg.customWriters || '').trim();
      if (extra) {
        var seen = {};
        lastInfo.writers.forEach(function (p) { seen[p.name] = 1; });
        splitPersons(extra).forEach(function (p) {
          if (p.name && !seen[p.name]) { seen[p.name] = 1; lastInfo.writers.push(p); }
        });
      }
      regenerate();
      return;
    }
    if (!lastRaw || !lastId) return;
    lastInfo = normalizeAll(lastId, lastRaw);
    regenerate();
  }

  /* ======================== 动作 ======================== */

  function showCandidates(items) {
    ui.cand.innerHTML = '';
    if (!items.length) { ui.cand.classList.add('hide'); return; }
    items.forEach(function (it) {
      var a = el('a', '', (it.title || '') + '　' + (it.year || '') + '　' + (it.sub_title || '') + '　[' + it.id + ']');
      a.onclick = function () {
        ui.url.value = 'https://movie.douban.com/subject/' + it.id + '/';
        ui.cand.classList.add('hide');
        runGenerate();
      };
      ui.cand.appendChild(a);
    });
    ui.cand.classList.remove('hide');
  }

  // 点「生成」后不再钉住面板：鼠标移开照样自动收起，进度看左上角「豆」的颜色
  function runGenerate() {
    pinned = false;
    generate();
  }

  function generate(imdbOverride) {
    if (!imdbOverride) lastImdbBundle = null;
    var parsed = parseInput(ui.url.value);
    if (!parsed) { status('先输入豆瓣链接、IMDb 链接、条目 ID 或片名', 'err'); return; }
    if (parsed.error) { status(parsed.error, 'err'); return; }
    if (ui.bOpen) ui.bOpen.textContent = parsed.imdb ? '打开 IMDb' : '打开豆瓣';
    if (parsed.imdb) {
      var tt = parsed.imdb;
      cfg.lastUrl = ui.url.value.trim(); saveCfg();
      ui.cand.classList.add('hide');
      status('读取 IMDb ' + tt + ' 并反查豆瓣条目…');
      setTabState('busy', 'IMDb 反查…');
      findDoubanByImdb(tt).then(function (r) {
        if (r.best) {
          lastImdbBundle = r.bundle;
          ui.url.value = SUBJECT_URL.replace('{id}', r.best.id);
          status('IMDb ' + tt + ' → 豆瓣《' + r.best.title + '》，正在读取完整条目…');
          generate(tt);          // 命中豆瓣：走完整抓取链路，并把已知 tt 带下去
          return;
        }
        // 没匹配到可信豆瓣条目：用 IMDb 数据直接生成，绝不空手而归
        if (!r.bundle.im && !r.bundle.cm) {
          status('IMDb ' + tt + ' 的元数据也没取到（可能被网络拦截），请直接粘贴豆瓣链接', 'err');
          setTabState('fail', 'IMDb 未取到数据');
          return;
        }
        var info = imdbOnlyInfo(tt, r.bundle);
        lastInfo = info; lastRaw = null; lastId = ''; lastImdbBundle = r.bundle;
        ui.preview.value = buildDescription(info, cfg);
        setTabState('ready', 'IMDb 数据已生成', '《' + info.title + '》· 由 IMDb 数据生成，展开查看');
        status('IMDb ' + tt + ' 未匹配到豆瓣条目，已用 IMDb 数据生成《' + info.title + '》' +
               (r.items.length ? '；下方候选条目可点选切换为豆瓣数据' : '；粘贴豆瓣链接可获得更全信息'), 'ok');
        if (r.items.length) showCandidates(r.items.slice(0, 8));
        else ui.cand.classList.add('hide');
      });
      return;
    }
    if (parsed.query) {
      status('按片名搜索「' + parsed.query + '」…');
      setTabState('busy', '按片名搜索…');
      suggest(parsed.query).then(function (items) {
        if (!items.length) { status('豆瓣没搜到，请直接粘贴条目链接', 'err'); setTabState('fail', '没搜到条目'); }
        else { showCandidates(items); status('找到 ' + items.length + ' 个条目，点选一个生成'); setTabState('fail', '请手选条目'); }
      });
      return;
    }
    cfg.lastUrl = ui.url.value.trim();
    saveCfg();
    ui.cand.classList.add('hide');
    status('读取豆瓣条目 ' + parsed.id + ' …');
    setTabState('busy', '读取条目…');

    fetchAll(parsed.id).then(function (raw) {
      var info = normalizeAll(parsed.id, raw);
      if (!info.title) {
        status('没拿到数据：请先在浏览器登录豆瓣并通过验证，再点「豆瓣」打开条目页后重试。', 'err');
        setTabState('fail', '未取到数据');
        return;
      }
      // 由 IMDb 反查进来：把已知的 tt 号、IMDb 海报直接补上，省掉二次匹配
      if (imdbOverride) {
        if (!info.imdb) info.imdb = imdbOverride;
        var bi = lastImdbBundle && lastImdbBundle.im;
        if (!info.posterImdb && bi && bi.imageUrl) info.posterImdb = imdbPosterUrl(bi.imageUrl);
        var bc = lastImdbBundle && lastImdbBundle.cm;
        if (bc && !info.intro && bc.description) info.intro = String(bc.description).trim();
      }
      lastInfo = info; lastRaw = raw; lastId = parsed.id;
      ui.preview.value = buildDescription(info, cfg);
      var blocked = !raw.page || isBlocked(raw.page);
      status('已生成《' + info.title + '》' + (info.year ? ' · ' + info.year : '') +
             (blocked ? '（条目页被拦，编剧/IMDb 可能不全）' : ''), 'ok');
      setTabState('ready', '已就绪 · 展开查看', '已生成《' + info.title + '》，点击展开');

      if (!info.imdb) {
        var pageTt = imdbFromPage();
        if (pageTt) {
          info.imdb = pageTt;
          if (cfg.imdb) regenerate();
        } else {
          fetchImdbId(info).then(function (tt) {
            if (!tt) return;
            info.imdb = tt;
            if (cfg.imdb) regenerate();
            status('已生成《' + info.title + '》 · IMDb 自动匹配 ' + tt, 'ok');
            attachImdbPoster(info);
          });
        }
      }
      attachImdbPoster(info);
    }).catch(function (e) {
      status('生成失败：' + (e && e.message ? e.message : e), 'err');
    });
  }

  function copy() {
    var text = ui.preview.value;
    if (!text.trim()) { status('预览是空的', 'err'); return; }

    function done() {
      status('已复制 · ' + text.length + ' 字符', 'ok');
      setTabState('ready', '已复制 · 展开查看', '简介已复制，共 ' + text.length + ' 字符');
      setExpanded(false);   // 复制完就收起，回到干净的详情页
    }
    if (gm.copy(text)) { done(); return; }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        ui.preview.select(); document.execCommand('copy'); done();
      });
    } else {
      ui.preview.select();
      document.execCommand('copy');
      done();
    }
  }

  function openDouban() {
    var p = parseInput(ui.url.value);
    var target = '';
    if (p && p.id) target = SUBJECT_URL.replace('{id}', p.id);
    else if (lastInfo && lastInfo.source === 'imdb' && lastInfo.imdbUrl) {
      gm.open(lastInfo.imdbUrl);
      status('已打开 IMDb 影片页；找到豆瓣链接后粘贴进来可补全信息', 'ok');
      return;
    }
    else if (lastInfo && lastInfo.url) target = lastInfo.url;
    gm.open(target || 'https://movie.douban.com/');
    status('已打开豆瓣；通过验证后回来点「生成」', 'ok');
  }

  /* ================== 自动取链（只填输入框，不发请求） ================== */

  var autoDone = false;

  function autoRun(retry) {
    if (autoDone) return;
    if (ui.url.value.trim()) return;   // 用户已经手动填了链接，不覆盖

    if (!cfg.autoFromPage) {
      setTabState('', '手动输入', '自动取链已关闭，展开后粘贴豆瓣链接');
      return;
    }

    var dbId = pageDoubanId();
    if (dbId) {
      autoDone = true;
      ui.url.value = SUBJECT_URL.replace('{id}', dbId);
      setTabState('ready', '已取到链接', '已自动填入豆瓣链接 ' + dbId + '，展开后点「生成」');
      status('已自动填入豆瓣链接 ' + dbId + '；点「生成」再读取条目');
      return;
    }

    var tt = imdbFromPage();
    if (tt) {
      autoDone = true;
      ui.url.value = 'https://www.imdb.com/title/' + tt + '/';
      setTabState('ready', '已取到 IMDb 链接', '页面只有 IMDb 链接 ' + tt + '，点「生成」反查豆瓣，匹配不到也能直接出简介');
      status('页面只有 IMDb 链接 ' + tt + '，已填入；点「生成」即可生成简介');
      return;
    }

    // 页面可能懒加载，稍后重试几次（仍然只读 DOM）
    if (retry > 0) {
      setTimeout(function () { autoRun(retry - 1); }, 600);
      return;
    }

    setTabState('', '待粘贴链接', '页面没有豆瓣 / IMDb 链接，展开后可手动粘贴');
  }

  /* ======================== 启动 ======================== */

  window.__DBPT__ = {
    parseInput: parseInput,
    normalizeAll: normalizeAll,
    buildDescription: buildDescription,
    pageDoubanId: pageDoubanId,
    imdbFromPage: imdbFromPage,
    pageGuessTitle: pageGuessTitle,
    imdbPosterUrl: imdbPosterUrl,
    imdbMeta: imdbMeta,
    cinemeta: cinemeta,
    imdbBundle: imdbBundle,
    findDoubanByImdb: findDoubanByImdb,
    imdbOnlyInfo: imdbOnlyInfo,
    generate: generate,
    autoRun: autoRun,
    isDetailPage: isDetailPage,
    attachImdbPoster: attachImdbPoster,
    checkUpdate: checkUpdate,
    isNewer: isNewer,
    version: SCRIPT_VERSION,
    open: function () { if (!root) buildUI(); pinned = true; setExpanded(true); }
  };

  function isDetailPage() {
    if (!/\/details\.php$/i.test(location.pathname)) return false;
    if (!/[?&]id=\d+/.test(location.search)) return false;
    // 编辑 / 管理 / 评分类的带参模式一律不介入（避免在种子编辑页冒出来）
    if (/[?&](edit|takeedit|mod|comment|dllist|uploader|act=)/i.test(location.search)) return false;
    // 页面上已经渲染出编辑表单，说明处于编辑态
    try {
      if (document.querySelector('form[action*="takeedit"], input[name="takeedit"], textarea[name="descr"]')) return false;
    } catch (e) { /* ignore */ }
    return true;
  }

  function boot() {
    if (!/(^|\.)hdwing\.org$/i.test(location.host)) return;
    if (!isDetailPage()) return;
    buildUI();
    setExpanded(false); // 详情页默认收起，鼠标悬停左上角入口才展开
    setTimeout(function () { if (!dragged) positionWidgets(); }, 300);
    setTimeout(function () { autoRun(3); }, 450);
    // 更新检测：先用上次缓存的结果点亮红点，再按周期满一次拉新
    if (cfg.latestVersion && isNewer(cfg.latestVersion, SCRIPT_VERSION)) {
      updateInfo = { version: cfg.latestVersion };
    }
    renderUpdateUI();
    setTimeout(function () { checkUpdate(false); }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
