/* 课堂点名 v2 —— 同学端（扫码签到） + 班长端（点名 / 名单 / 导出）
   后端：自建服务（房间号 + PIN，数据落班长手机本地 + 云端存档） */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var CN_NAME = /^[\u4e00-\u9fa5·]{2,10}$/;
  // 隐私条款版本：改动《隐私说明》内容时必须同步 +1，用户会被要求重新确认
  var PRIVACY_VER = '2026-10-15';
  var state = { profile: null, roster: [], session: null, subs: [], rejects: [], timer: null, report: null, history: [] };

  /* ---------------- 基础工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function show(id, on) { var el = $(id); if (el) el.classList.toggle('hidden', !on); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function notice(id, text, kind) {
    var el = $(id);
    if (!el) return;
    if (!text) { el.className = 'notice hidden'; el.textContent = ''; return; }
    el.className = 'notice notice-' + (kind || 'info');
    el.textContent = text;
  }
  function two(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }
  function fmtFile(ts) {
    var d = ts ? new Date(ts) : new Date();
    return '' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes());
  }
  function vibrate(ms) {
    try { if (window.AndroidBridge && window.AndroidBridge.vibrate) { window.AndroidBridge.vibrate(ms); return; } } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }
  function download(filename, blob) {
    if (window.AndroidBridge && window.AndroidBridge.saveFile) {
      var fr = new FileReader();
      fr.onload = function () {
        window.AndroidBridge.saveFile(filename, String(fr.result).split(',')[1] || '');
      };
      fr.readAsDataURL(blob);
      return;
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  function siteBase() {
    var base = CFG.siteOrigin || (location.origin + location.pathname.replace(/[^/]*$/, ''));
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return base;
  }
  async function sha256(s) {
    if (window.crypto && crypto.subtle) {
      var h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    var x = 0;
    for (var i = 0; i < s.length; i++) x = ((x << 5) - x + s.charCodeAt(i)) | 0;
    return 'fb' + (x >>> 0).toString(16) + s.length;
  }
  // 存储身份：优先 cookie（只清 localStorage 的工具/操作清不掉它），并保留历史身份列表。
  // 关键用途：cookie 里留着的旧身份 vs 新的 localStorage 身份不一致 → 说明有人清过存储。
  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  function writeCookie(name, val) {
    try { document.cookie = name + '=' + encodeURIComponent(val) + '; max-age=31536000; path=/; SameSite=Lax'; } catch (e) {}
  }
  function plantId(id) {
    LS.set('ck_device_id', id);
    try { sessionStorage.setItem('ck_device_id', id); } catch (e) {}
    writeCookie('ck_device_id', id);
    var hist = LS.get('ck_device_hist', []) || [];
    var fromCookie = readCookie('ck_device_hist');
    if (fromCookie) fromCookie.split(',').forEach(function (v) { if (v && hist.indexOf(v) < 0) hist.push(v); });
    if (hist.indexOf(id) < 0) hist.push(id);
    if (hist.length > 6) hist = hist.slice(-6);
    LS.set('ck_device_hist', hist);
    writeCookie('ck_device_hist', hist.join(','));
  }
  function deviceFp() {
    var id = readCookie('ck_device_id');
    if (!id) id = LS.get('ck_device_id', '');
    if (!id) { try { id = sessionStorage.getItem('ck_device_id') || ''; } catch (e) {} }
    if (!id) id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    plantId(id);
    return 'f' + id;
  }
  // 这台设备用过的全部身份（cookie/localStorage/sessionStorage 三处冗余）
  function deviceFpList() {
    var out = [];
    function add(v) { if (v && out.indexOf(v) < 0) out.push(v); }
    (LS.get('ck_device_hist', []) || []).forEach(add);
    var c = readCookie('ck_device_hist');
    if (c) c.split(',').forEach(add);
    add(readCookie('ck_device_id'));
    add(LS.get('ck_device_id', ''));
    try { add(sessionStorage.getItem('ck_device_id') || ''); } catch (e) {}
    add(deviceFp().slice(1));
    return out.slice(-6);
  }
  // 属性指纹：不依赖任何存储，清缓存/换隐身模式也基本不变
  // = 屏幕 + 像素比 + 时区语言 + 核心/内存/触点数 + 已装字体（含字号影响）+ Canvas/WebGL 渲染特征
  function deviceSig() {
    var parts = [];
    try {
      parts.push(screen.width + 'x' + screen.height);
      parts.push((screen.availWidth || 0) + 'x' + (screen.availHeight || 0));
      parts.push(screen.colorDepth + '/' + (window.devicePixelRatio || 1));
      parts.push(new Date().getTimezoneOffset());
      parts.push(navigator.language || '');
      parts.push(navigator.platform || '');
      parts.push(navigator.hardwareConcurrency || 0);
      parts.push(navigator.deviceMemory || 0);
      parts.push(navigator.maxTouchPoints || 0);
    } catch (e) {}
    parts.push(fontProbe());
    parts.push(canvasSig());
    return hashStr(parts.join('|'));
  }

  // 字体探测：测量不同字体下的文本宽度差异，能反映"装了哪些字体"和"字号设置"
  function fontProbe() {
    try {
      var fonts = ['Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana', 'Tahoma',
        'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Helvetica Neue', 'PingFang SC',
        'Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'Noto Sans CJK SC', 'Source Han Sans',
        'WenQuanYi Micro Hei', 'Roboto', 'Droid Sans', 'HarmonyOS Sans'];
      var bases = ['monospace', 'sans-serif', 'serif'];
      var c = document.createElement('canvas');
      var g = c.getContext('2d');
      if (!g) return '';
      var probe = 'mmmmmmmmmmlliWMN@0123456789';
      var out = [];
      for (var i = 0; i < bases.length; i++) {
        g.font = '72px ' + bases[i];
        var bw = g.measureText(probe).width;
        for (var j = 0; j < fonts.length; j++) {
          g.font = '72px "' + fonts[j] + '",' + bases[i];
          var w = g.measureText(probe).width;
          if (Math.abs(w - bw) > 0.1) out.push(fonts[j] + ':' + (w - bw).toFixed(2));
        }
      }
      return out.join(',');
    } catch (e) {
      return '';
    }
  }

  function canvasSig() {
    try {
      var c = document.createElement('canvas');
      c.width = 220; c.height = 40;
      var g = c.getContext('2d');
      if (!g) return '';
      g.textBaseline = 'top';
      g.font = '14px Arial';
      g.fillStyle = '#f60'; g.fillRect(0, 0, 100, 20);
      g.fillStyle = '#069'; g.fillText('签到ClassCheckin', 2, 2);
      g.fillStyle = 'rgba(102,204,0,0.7)'; g.fillText('签到ClassCheckin', 4, 6);
      var d = c.toDataURL();
      return d.slice(-80) + d.length;
    } catch (e) {
      return '';
    }
  }

  function hashStr(s) {
    var h1 = 5381, h2 = 52711;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = ((h1 << 5) + h1 + c) | 0;
      h2 = ((h2 << 5) + h2 ^ c) | 0;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }
  function getGeo(timeoutMs) {
    timeoutMs = timeoutMs || 4500;
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve({ err: 'unsupported' });
      var done = false;
      function finish(v) { if (done) return; done = true; clearTimeout(t); resolve(v); }
      var t = setTimeout(function () { finish({ err: 'timeout' }); }, timeoutMs + 300);
      navigator.geolocation.getCurrentPosition(
        function (p) {
          finish({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            acc: (p.coords.accuracy != null ? p.coords.accuracy : null)
          });
        },
        function (e) {
          var code = e && e.code;
          finish({ err: code === 1 ? 'denied' : (code === 3 ? 'timeout' : 'unavailable') });
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 }
      );
    });
  }

  /* ---------------- 本地存储 ---------------- */
  var LS = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  function rosterKey() { return 'ck_roster_' + (state.profile ? state.profile.room : ''); }
  function historyKey() { return 'ck_history_' + (state.profile ? state.profile.room : ''); }
  function loadRosterLocal() { state.roster = LS.get(rosterKey(), []) || []; }
  function saveRosterLocal() { LS.set(rosterKey(), state.roster); }
  function loadHistory() { state.history = LS.get(historyKey(), []) || []; }
  function saveHistory() {
    if (state.history.length > 60) state.history = state.history.slice(-60);
    LS.set(historyKey(), state.history);
  }
  function activeRoster() { return state.roster.filter(function (s) { return s.active !== false; }); }

  /* ---------------- 按需加载大库（首屏只加载必要脚本，弱网也不白屏） ---------------- */
  var libCache = {};
  function loadScript(src) {
    if (libCache[src]) return libCache[src];
    libCache[src] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(true); };
      s.onerror = function () { libCache[src] = null; rej(new Error('脚本加载失败，请检查网络后重试')); };
      document.head.appendChild(s);
    });
    return libCache[src];
  }
  function ensureLib(name) {
    if (name === 'xlsx') return window.XLSX ? Promise.resolve(true) : loadScript('libs/xlsx.full.min.js');
    if (name === 'qrcode') return window.qrcode ? Promise.resolve(true) : loadScript('libs/qrcode.js');
    return Promise.resolve(true);
  }

  /* ---------------- 接口 ---------------- */
  async function api(method, path, body) {
    var opt = { method: method, headers: {} };
    if (method === 'POST') { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body || {}); }
    for (var i = 0; i < 3; i++) {
      try {
        var r = await fetch(path, opt);
        var data = await r.json();
        if (!r.ok && (!data || data.ok !== false)) return { error: 'HTTP ' + r.status };
        return { data: data };
      } catch (e) {
        if (i === 2) return { error: 'network' };
        await sleep(400 + i * 700);
      }
    }
    return { error: 'network' };
  }
  function qs(extra) {
    var p = state.profile || {};
    return 'room=' + encodeURIComponent(p.room || '') + '&pinKey=' + encodeURIComponent(p.pinKey || '') + (extra || '');
  }

  /* ================= 同学端 ================= */
  var stu = { code: '', busy: false, done: false };

  function consented() { return LS.get('ck_privacy', '') === PRIVACY_VER; }
  function bindConsent() {
    if (bindConsent.done) return;
    bindConsent.done = true;
    $('btn-consent-ok').addEventListener('click', function () {
      LS.set('ck_privacy', PRIVACY_VER);
      show('stu-consent', false);
      refreshStudentInfo();
    });
    $('btn-consent-more').addEventListener('click', function () { location.href = 'privacy.html'; });
  }
  function initStudent(code) {
    stu.code = code;
    show('boot', false);
    show('view-student', true);
    show('stu-form', false);
    bindStudentForm();
    bindConsent();
    if (!consented()) { show('stu-consent', true); return; }
    refreshStudentInfo();
  }

  async function refreshStudentInfo() {
    var res = await api('GET', 'api/s/' + encodeURIComponent(stu.code));
    var info = res.data;
    if (!info) {
      show('stu-form', true);
      $('stu-name-hint').textContent = '网络不太顺，仍可尝试提交';
      return;
    }
    if (!info.ok) {
      show('stu-form', false);
      show('stu-error', true);
      $('stu-error-text').textContent = info.message || '二维码无效';
      $('stu-retry').classList.remove('hidden');
      return;
    }
    $('stu-course').textContent = info.course ? '课程：' + info.course : '';
    if (info.status !== 'open') {
      show('stu-form', false);
      show('stu-done', true);
      document.querySelector('#stu-done .result-big').textContent = '—';
      $('stu-done-title').textContent = '点名已结束';
      $('stu-done-sub').textContent = '本次点名已关闭，无法签到';
      return;
    }
    if (stu.done) return;
    show('stu-form', true);
    $('stu-sub').textContent = '请输入你的姓名完成签到';
  }

  function bindStudentForm() {
    var input = $('stu-name');
    var composing = false;
    function filter() {
      var v = input.value.replace(/[^\u4e00-\u9fa5·]/g, '').slice(0, 10);
      if (v !== input.value) input.value = v;
      $('stu-submit').disabled = !CN_NAME.test(input.value) || stu.busy;
    }
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; filter(); });
    input.addEventListener('input', function () { if (!composing) filter(); });
    $('stu-submit').addEventListener('click', doCheckin);
    $('stu-retry').addEventListener('click', function () {
      show('stu-error', false);
      show('stu-form', false);
      refreshStudentInfo();
    });
    filter();
  }

  function stuShow(status, data, geo) {
    show('stu-form', false);
    show('stu-error', false);
    if (status === 'ok' || status === 'already') {
      show('stu-done', true);
      document.querySelector('#stu-done .result-big').textContent = '✓';
      $('stu-done-title').textContent = status === 'already' ? '你已经签到过了' : '签到成功';
      var sub = data && data.name ? data.name : '';
      if (data && data.position) sub += '　你是第 ' + data.position + ' 位';
      if (geo && geo.err) {
        sub += geo.err === 'denied'
          ? '　（未授权定位，这条记录会被标注「未提供定位」）'
          : '　（没拿到定位，这条记录会被标注「未提供定位」）';
      }
      $('stu-done-sub').textContent = sub;
      stu.done = true;
      vibrate(60);
      return;
    }
    if (status === 'closed' || status === 'invalid') {
      show('stu-done', true);
      document.querySelector('#stu-done .result-big').textContent = status === 'closed' ? '—' : '?';
      $('stu-done-title').textContent = status === 'closed' ? '点名已结束' : '二维码无效';
      $('stu-done-sub').textContent = (data && data.message) || '';
      return;
    }
    show('stu-error', true);
    $('stu-error-text').textContent = (data && data.message) || '提交失败，请重试';
    $('stu-retry').classList.remove('hidden');
  }

  async function doCheckin() {
    var name = $('stu-name').value.trim();
    if (!CN_NAME.test(name) || stu.busy) return;
    stu.busy = true;
    $('stu-submit').disabled = true;
    $('stu-submit').innerHTML = '<span class="spin"></span> 提交中';
    var geo = await getGeo(4500);
    var res = await api('POST', 'api/checkin', {
      code: stu.code, name: name, fp: deviceFp(), ids: deviceFpList(), sig: deviceSig(),
      lat: geo && geo.lat != null ? geo.lat : null,
      lng: geo && geo.lng != null ? geo.lng : null,
      acc: geo && geo.acc != null ? geo.acc : null,
      geoErr: (geo && geo.err) || null,
      ua: (navigator.userAgent || '').slice(0, 200)
    });
    stu.busy = false;
    $('stu-submit').innerHTML = '签 到';
    $('stu-submit').disabled = false;
    if (!res.data) { stuShow('network', { message: '网络不太好，请检查流量后重试' }); return; }
    stuShow(res.data.status, res.data, geo);
  }

  /* ================= 班长端 ================= */
  function adminScreen(name) {
    ['setup', 'lock', 'home', 'live', 'report', 'history', 'roster'].forEach(function (s) {
      show('scr-' + s, s === name);
    });
  }

  function bindSetup() {
    if (bindSetup.done) return;
    bindSetup.done = true;
    $('btn-create-room').addEventListener('click', async function () {
      var className = $('setup-name').value.trim();
      var room = $('setup-code').value.trim();
      var pin = $('setup-pin').value.trim();
      var pin2 = $('setup-pin2').value.trim();
      var radius = parseInt($('setup-radius').value, 10) || 200;
      if (!className || !room) return notice('setup-msg', '班级名和房间号都要填', 'bad');
      if (!/^[0-9A-Za-z\u4e00-\u9fa5_-]{2,16}$/.test(room)) return notice('setup-msg', '房间号 2-16 位，字母数字或中文', 'bad');
      if (!/^\d{4,6}$/.test(pin)) return notice('setup-msg', 'PIN 用 4-6 位数字', 'bad');
      if (pin !== pin2) return notice('setup-msg', '两次 PIN 不一致', 'bad');
      if (!$('setup-agree').checked) return notice('setup-msg', '请先阅读并勾选同意《隐私说明》', 'bad');
      var key = (await sha256(room + '|' + pin)).slice(0, 32);
      notice('setup-msg', '正在检查房间号…', 'info');
      var chk = await api('GET', 'api/history?room=' + encodeURIComponent(room) + '&pinKey=' + key);
      if (chk.data && chk.data.message === '房间口令不对') {
        return notice('setup-msg', '房间号「' + room + '」在服务器上已有记录，但和这个 PIN 对不上：要么填回原来的 PIN，要么换一个房间号。', 'bad');
      }
      state.profile = { className: className, room: room, pin: pin, pinKey: key, radius: radius, agreeVer: PRIVACY_VER };
      LS.set('ck_profile', state.profile);
      notice('setup-msg', '建好了', 'ok');
      enterHome();
    });
    $('btn-lock-enter').addEventListener('click', async function () {
      var p = state.profile;
      if (!p) return showSetup();
      var pin = $('lock-pin').value.trim();
      if (!pin) return notice('lock-msg', '请输入 PIN', 'bad');
      if (!state.profile.agreeVer || state.profile.agreeVer !== PRIVACY_VER) {
        if (!$('lock-agree').checked) return notice('lock-msg', '请先阅读并勾选同意《隐私说明》', 'bad');
        state.profile.agreeVer = PRIVACY_VER;
        LS.set('ck_profile', state.profile);
      }
      var key = (await sha256(p.room + '|' + pin)).slice(0, 32);
      if (key !== p.pinKey) return notice('lock-msg', 'PIN 不对', 'bad');
      notice('lock-msg', '', 'info');
      $('lock-pin').value = '';
      enterHome();
    });
    $('lock-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btn-lock-enter').click(); });
    $('btn-stu-manual').addEventListener('click', function () {
      var c = ($('stu-code-manual').value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (c.length < 4) return notice('lock-msg', '口令在班长屏幕二维码下面，是 6 位字母数字', 'bad');
      show('view-admin', false);
      initStudent(c);
    });
    $('btn-lock-reset').addEventListener('click', function () {
      if (!window.confirm('重置会清掉这台手机上的班级设置与历史记录（云端存档仍在），确定？')) return;
      LS.del('ck_profile');
      state.profile = null;
      showSetup();
    });
  }

  function showSetup() {
    adminScreen('setup');
    $('setup-radiushint') && ($('setup-radiushint').textContent = '');
  }

  function showLock() {
    adminScreen('lock');
    $('lock-room').textContent = state.profile ? (state.profile.className + '（房间号 ' + state.profile.room + '）') : '';
    show('lock-agree-box', !state.profile || state.profile.agreeVer !== PRIVACY_VER);
    setTimeout(function () { try { $('lock-pin').focus(); } catch (e) {} }, 200);
  }

  async function enterHome() {
    loadRosterLocal();
    loadHistory();
    adminScreen('home');
    renderHome();
  }

  function renderHome() {
    var p = state.profile || {};
    $('home-room-name').textContent = p.className || p.room || '';
    $('home-room-code').textContent = '房间号 ' + (p.room || '');
    $('home-stu-count').textContent = activeRoster().length;
    var last = state.history[state.history.length - 1];
    $('home-last').textContent = last
      ? ((last.course ? last.course + ' · ' : '') + fmt(last.openedAt) + '（' + (last.subs ? last.subs.length : 0) + ' 人提交）')
      : '暂无';
  }

  function bindHome() {
    $('btn-logout').addEventListener('click', function () { showLock(); });
    $('btn-goto-roster').addEventListener('click', function () { renderRoster(); adminScreen('roster'); });
    $('btn-goto-history').addEventListener('click', function () { renderHistory(); adminScreen('history'); });
    $('btn-start').addEventListener('click', startSession);
  }

  /* ---------- 名单校验：只上传姓名哈希，不上传明文 ---------- */
  async function rosterHashes() {
    var salt = LS.get('ck_salt', '');
    if (!salt) { salt = 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); LS.set('ck_salt', salt); }
    var list = activeRoster();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push((await sha256(salt + '|' + list[i].name)).slice(0, 32));
    }
    return { nameSalt: salt, nameHashes: out };
  }
  async function syncRosterHashes() {
    if (!state.session || !state.profile) return 0;
    var rh = await rosterHashes();
    var r = await api('POST', 'api/roster', {
      room: state.profile.room, pinKey: state.profile.pinKey,
      code: state.session.code, nameSalt: rh.nameSalt, nameHashes: rh.nameHashes
    });
    return (r.data && r.data.count) || 0;
  }

  /* ---------- 花名册（只存这台手机） ---------- */
  function renderRoster() {
    var act = state.roster.filter(function (s) { return s.active !== false; });
    var off = state.roster.filter(function (s) { return s.active === false; });
    $('roster-info').textContent = '在册 ' + act.length + ' 人' + (off.length ? '，已停用 ' + off.length + ' 人' : '') + '；花名册只存在这台手机上。';
    var html = act.map(function (s) {
      return '<li><span class="grow">' + esc(s.name) + (s.no ? ' <span class="tiny">' + esc(s.no) + '</span>' : '') +
        '</span><button class="btn btn-sm" data-off="' + esc(s.name) + '">停用</button></li>';
    }).join('');
    html += off.map(function (s) {
      return '<li><span class="grow" style="color:#9aa1a9">' + esc(s.name) + '</span><button class="btn btn-sm" data-on="' + esc(s.name) + '">启用</button></li>';
    }).join('');
    $('roster-list').innerHTML = html || '<li class="muted">还没有花名册，点上面导入 Excel</li>';
    Array.prototype.forEach.call($('roster-list').querySelectorAll('[data-off]'), function (b) {
      b.addEventListener('click', function () { setActive(b.getAttribute('data-off'), false); });
    });
    Array.prototype.forEach.call($('roster-list').querySelectorAll('[data-on]'), function (b) {
      b.addEventListener('click', function () { setActive(b.getAttribute('data-on'), true); });
    });
  }

  function setActive(name, active) {
    state.roster.forEach(function (s) { if (s.name === name) s.active = active; });
    saveRosterLocal();
    renderRoster();
  }

  function mergeRoster(list) {
    var byName = {};
    state.roster.forEach(function (s) { byName[s.name] = s; });
    var added = 0, updated = 0;
    list.forEach(function (x) {
      if (byName[x.name]) {
        if (x.no && byName[x.name].no !== x.no) { byName[x.name].no = x.no; updated++; }
        byName[x.name].active = true;
      } else {
        state.roster.push({ name: x.name, no: x.no || '', active: true });
        added++;
      }
    });
    saveRosterLocal();
    return { added: added, updated: updated, total: state.roster.length };
  }

  function bindRoster() {
    if (bindRoster.done) return;
    bindRoster.done = true;
    $('btn-roster-back').addEventListener('click', function () { renderHome(); adminScreen('home'); });
    $('btn-import').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', async function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      notice('roster-msg', '正在解析 ' + f.name + ' …', 'info');
      try {
        var rows = await readTable(f);
        var list = extractRoster(rows);
        if (!list.length) { notice('roster-msg', '没读到姓名，确认表里有一列是「姓名」', 'bad'); return; }
        var r = mergeRoster(list);
        renderRoster();
        notice('roster-msg', '导入完成：新增 ' + r.added + ' 人，更新 ' + r.updated + ' 人，现在共 ' + r.total + ' 人', 'ok');
      } catch (err) {
        notice('roster-msg', '导入失败：' + (err && err.message ? err.message : '文件格式不支持'), 'bad');
      }
    });
    $('btn-add-stu').addEventListener('click', function () {
      $('roster-info').innerHTML = '新同学姓名：<input id="add-name" style="margin-top:6px" placeholder="中文姓名">' +
        '<button class="btn" id="add-save" style="margin-top:8px">保存</button>';
      try { $('add-name').focus(); } catch (e) {}
      $('add-save').addEventListener('click', function () {
        var n = $('add-name').value.trim();
        if (!CN_NAME.test(n)) { notice('roster-msg', '请填 2-10 个汉字的姓名', 'bad'); return; }
        mergeRoster([{ name: n, no: '' }]);
        renderRoster();
        notice('roster-msg', '已加入 ' + n, 'ok');
      });
    });
  }

  async function readTable(file) {
    await ensureLib('xlsx');
    var buf = await file.arrayBuffer();
    if (/\.csv$/i.test(file.name)) return parseCsv(new TextDecoder('utf-8').decode(buf));
    var wb = window.XLSX.read(buf, { type: 'array' });
    var ws = wb.Sheets[wb.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  }

  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function extractRoster(rows) {
    var nameCol = -1, noCol = -1, start = 0, i, j;
    for (i = 0; i < Math.min(rows.length, 6); i++) {
      var r = rows[i] || [];
      for (j = 0; j < r.length; j++) {
        if (/姓名|名字|学生姓名/.test(String(r[j]))) { nameCol = j; start = i + 1; break; }
      }
      if (nameCol >= 0) {
        for (j = 0; j < r.length; j++) { if (/学号|学籍号|编号/.test(String(r[j]))) { noCol = j; break; } }
        break;
      }
    }
    if (nameCol < 0) {
      var width = 0;
      for (i = 0; i < Math.min(rows.length, 20); i++) width = Math.max(width, (rows[i] || []).length);
      var bestC = -1, bestN = 0;
      for (j = 0; j < width; j++) {
        var n = 0;
        for (i = 0; i < Math.min(rows.length, 40); i++) {
          if (CN_NAME.test(String((rows[i] || [])[j] == null ? '' : (rows[i] || [])[j]).trim())) n++;
        }
        if (n > bestN) { bestN = n; bestC = j; }
      }
      if (bestC < 0 || bestN < 1) return [];
      nameCol = bestC;
      for (j = 0; j < width; j++) {
        if (j === nameCol) continue;
        var num = 0, tot = 0;
        for (i = 0; i < Math.min(rows.length, 20); i++) {
          var v = String((rows[i] || [])[j] == null ? '' : (rows[i] || [])[j]).trim();
          if (!v) continue;
          tot++;
          if (/^\d{6,}$/.test(v)) num++;
        }
        if (tot && num === tot) { noCol = j; break; }
      }
    }
    var out = [], seen = {};
    for (i = start; i < rows.length; i++) {
      var rr = rows[i] || [];
      var raw = String(rr[nameCol] == null ? '' : rr[nameCol]).replace(/\s/g, '');
      if (!CN_NAME.test(raw) || seen[raw]) continue;
      seen[raw] = 1;
      var no = noCol >= 0 ? String(rr[noCol] == null ? '' : rr[noCol]).replace(/\s/g, '') : '';
      out.push({ name: raw, no: no });
    }
    return out;
  }

  /* ---------- 点名 ---------- */
  async function startSession() {
    if (!activeRoster().length) { notice('home-msg', '花名册还是空的，先去「花名册」导入', 'bad'); return; }
    var btn = $('btn-start');
    var course = ($('home-course') && $('home-course').value ? $('home-course').value.trim() : '');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 定位中…';
    var geo = await getGeo(5000);
    btn.innerHTML = '开始点名';
    btn.disabled = false;
    var rh = await rosterHashes();
    var res = await api('POST', 'api/session', {
      room: state.profile.room, pinKey: state.profile.pinKey, course: course,
      lat: geo ? geo.lat : null, lng: geo ? geo.lng : null,
      radius: state.profile.radius || 200,
      nameSalt: rh.nameSalt, nameHashes: rh.nameHashes
    });
    if (!res.data || !res.data.ok) {
      notice('home-msg', (res.data && res.data.message) || '创建点名失败，请检查网络后重试', 'bad');
      return;
    }
    state.session = { code: res.data.code, course: course, openedAt: res.data.openedAt, geo: geo };
    state.subs = [];
    openLive();
  }

  async function openLive() {
    var s = state.session;
    $('live-course').textContent = (s.course ? s.course + ' · ' : '') + '进行中 ' + fmt(s.openedAt);
    $('live-code').textContent = s.code;
    $('live-hint').textContent = '已到人数' + (s.geo ? '（本次开启距离校验）' : '（未取到定位，本次不做距离校验）');
    notice('home-msg', '', 'info');
    adminScreen('live');
    renderLive();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(pollSubs, 2500);
    pollSubs();
    await drawQr();
  }

  async function drawQr() {
    var s = state.session;
    $('live-qr').innerHTML = '<p class="tiny center">二维码生成中…</p>';
    try {
      await ensureLib('qrcode');
      var qr = window.qrcode(0, 'M');
      qr.addData(siteBase() + '?s=' + s.code);
      qr.make();
      $('live-qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    } catch (e) {
      $('live-qr').innerHTML = '<div class="notice notice-warn">二维码没出来（网络问题）。点下面按钮重试，或直接让同学打开 ' +
        esc(siteBase()) + ' 后输口令 <b>' + esc(s.code) + '</b>。</div>' +
        '<button class="btn" id="btn-qr-retry" style="margin-top:8px">重新生成二维码</button>';
      var b = $('btn-qr-retry');
      if (b) b.addEventListener('click', drawQr);
    }
  }

  async function pollSubs() {
    if (!state.session) return;
    var res = await api('GET', 'api/live/' + state.session.code + '?' + qs());
    if (!res.data || !res.data.ok) return;
    if (res.data.subs.length > state.subs.length) vibrate(45);
    state.subs = res.data.subs;
    state.rejects = res.data.rejects || [];
    state.rosterCount = res.data.rosterCount || 0;
    renderLive();
  }

  function renderLive() {
    var names = {}, flagged = 0;
    state.subs.forEach(function (x) {
      names[x.name] = 1;
      if (x.flags && x.flags.length) flagged++;
    });
    $('live-count').textContent = Object.keys(names).length;
    $('live-total').textContent = '/' + activeRoster().length;
    if (flagged) {
      $('live-flags-card').style.display = '';
      $('live-flags').textContent = '已有 ' + flagged + ' 条提交被标黄，结束后可在「异常」里核对';
    } else {
      $('live-flags-card').style.display = 'none';
    }
    $('live-roster').textContent = state.rosterCount
      ? '名单校验已开启（' + state.rosterCount + ' 人）：不在名单里的名字会被直接拒收'
      : '名单校验未开启：任何中文名都能提交（只会被标黄），点下面按钮同步名单';
    var rej = state.rejects || [];
    if (rej.length) {
      // 按设备归并：一台设备一行，避免一个反复提交的人把卡片刷满
      var byFp = {}, order = [];
      rej.forEach(function (x) {
        if (!byFp[x.fp]) { byFp[x.fp] = { fp: x.fp, names: [], n: 0, last: 0, released: false }; order.push(x.fp); }
        var g = byFp[x.fp];
        g.n += (x.n || 1);
        g.last = Math.max(g.last, x.t || 0);
        if (g.names.indexOf(x.name) < 0) g.names.push(x.name);
        if (x.releasedAt) g.released = true;
      });
      var shown = order.slice(-5).reverse();
      var html = shown.map(function (fp) {
        var g = byFp[fp];
        var names = g.names.slice(0, 3).join('、') + (g.names.length > 3 ? ' 等 ' + g.names.length + ' 个名字' : '');
        return '<li><span class="grow">' + esc(names) +
          ' <span class="tiny">共 ' + g.n + ' 次 · 最近 ' + fmt(g.last).slice(11) + '</span>' +
          (g.released ? ' <span class="tag tag-ok">已放行</span>' : '') +
          '</span><button class="btn btn-sm" data-rel="' + esc(fp) + '">放行</button></li>';
      }).join('');
      if (order.length > shown.length) {
        html += '<li class="tiny" style="display:block">另有 ' + (order.length - shown.length) + ' 台设备被挡下（明细见导出文件）</li>';
      }
      $('live-reject-card').style.display = '';
      $('live-reject-title').textContent = '有 ' + order.length + ' 台设备提交被挡下（一部手机只能签一个名字）';
      $('live-reject-list').innerHTML = html;
      Array.prototype.forEach.call($('live-reject-list').querySelectorAll('[data-rel]'), function (b) {
        b.addEventListener('click', async function () {
          var fp = b.getAttribute('data-rel');
          b.disabled = true;
          var r = await api('POST', 'api/release', {
            room: state.profile.room, pinKey: state.profile.pinKey, code: state.session.code, fp: fp
          });
          if (!r.data || !r.data.ok) { notice('home-msg', (r.data && r.data.message) || '放行失败', 'bad'); b.disabled = false; return; }
          pollSubs();
        });
      });
    } else {
      $('live-reject-card').style.display = 'none';
    }
  }

  function bindLive() {
    if (bindLive.done) return;
    bindLive.done = true;
    $('btn-sync-roster').addEventListener('click', async function () {
      var b = $('btn-sync-roster');
      b.disabled = true;
      var n = await syncRosterHashes();
      b.disabled = false;
      if (n) { state.rosterCount = n; renderLive(); }
      notice('home-msg', n ? ('名单已同步：' + n + ' 人，不在名单里的提交会被拒收') : '同步失败，请检查网络', n ? 'ok' : 'bad');
    });
    $('btn-close-session').addEventListener('click', async function () {
      if (!state.session) return;
      var btn = $('btn-close-session');
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> 关闭中…';
      var res = await api('POST', 'api/close', { room: state.profile.room, pinKey: state.profile.pinKey, code: state.session.code });
      btn.disabled = false;
      btn.textContent = '结束点名';
      if (!res.data || !res.data.ok) { notice('home-msg', (res.data && res.data.message) || '关闭失败，请重试', 'bad'); return; }
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      state.subs = res.data.subs || state.subs;
      var rec = {
        code: state.session.code,
        course: state.session.course,
        openedAt: state.session.openedAt,
        closedAt: res.data.closedAt,
        subs: state.subs,
        leaves: [],
        rejects: res.data.rejects || state.rejects || []
      };
      state.history.push(rec);
      saveHistory();
      buildReport(rec);
    });
  }

  /* ---------- 结果名单 ---------- */
  function buildReport(rec) {
    state.report = rec;
    var roster = state.roster;
    var subs = rec.subs || [];
    var leaves = rec.leaves || [];
    var byName = {};
    subs.forEach(function (x) { if (!byName[x.name]) byName[x.name] = x; });
    var leaveSet = {};
    leaves.forEach(function (n) { leaveSet[n] = 1; });

    var ok = [], miss = [], leaveList = [], flagList = [];
    roster.forEach(function (st) {
      if (st.active === false) return;
      var sub = byName[st.name];
      if (sub) ok.push({ st: st, sub: sub });
      else if (leaveSet[st.name]) leaveList.push({ st: st, sub: null });
      else miss.push({ st: st, sub: null });
    });
    var known = {};
    roster.forEach(function (st) { known[st.name] = 1; });
    Object.keys(byName).forEach(function (n) {
      var sub = byName[n];
      if (!known[n]) flagList.push({ st: { name: n, no: '', id: null }, sub: sub, offRoster: true });
      else if (sub.flags && sub.flags.length) flagList.push({ st: { name: n }, sub: sub });
    });

    $('report-title').textContent = (rec.course ? rec.course + ' · ' : '') + '点名结果';
    $('report-sub').textContent = fmt(rec.openedAt) + ' 开始，' + (rec.closedAt ? fmt(rec.closedAt) + ' 结束' : '进行中');
    $('report-n-ok').textContent = ok.length;
    $('report-n-miss').textContent = miss.length;
    $('report-n-leave').textContent = leaveList.length;
    $('report-n-flag').textContent = flagList.length;

    $('report-miss').innerHTML = miss.length ? miss.map(function (x) {
      return '<li><span class="grow">' + esc(x.st.name) + '</span><button class="btn btn-sm" data-leave="' + esc(x.st.name) + '">请假</button></li>';
    }).join('') : '<li class="muted">全到齐了</li>';

    $('report-ok').innerHTML = ok.length ? ok.map(function (x) {
      return '<li><span class="grow">' + esc(x.st.name) + flagTags(x.sub) + '</span><span class="tiny">' +
        fmt(x.sub.t).slice(11) + '</span></li>';
    }).join('') : '<li class="muted">暂无</li>';

    $('report-leave-list').innerHTML = leaveList.length ? leaveList.map(function (x) {
      return '<li><span class="grow">' + esc(x.st.name) + '</span><button class="btn btn-sm" data-unleave="' + esc(x.st.name) + '">撤销</button></li>';
    }).join('') : '<li class="muted">无</li>';

    var rej = rec.rejects || [];
    $('report-flag').innerHTML = (flagList.length ? flagList.map(function (x) {
      return '<li><span class="grow">' + esc(x.sub.name) + flagTags(x.sub) +
        (x.sub.dist != null ? ' <span class="tiny">' + x.sub.dist + 'm</span>' : '') +
        ((x.sub.ipCity || x.sub.ipIsp) ? ' <span class="tiny">[' + esc(((x.sub.ipCity || '') + ' ' + (x.sub.ipIsp || '')).trim()) + ']</span>' : '') +
        '</span><span class="tiny">' + fmt(x.sub.t).slice(11) + '</span></li>';
    }).join('') : '<li class="muted">没有异常</li>') +
      (rej.length ? '<li style="display:block;padding-top:12px" class="tiny">被挡下的提交（一部手机只能签一个名字）共 ' + rej.length + ' 次：' +
        rej.slice(0, 8).map(function (x) { return esc(x.name) + '(' + fmt(x.t).slice(11) + ')'; }).join('、') +
        (rej.length > 8 ? ' …' : '') + '　—— 导出文件里另有明细表</li>' : '');

    Array.prototype.forEach.call($('report-miss').querySelectorAll('[data-leave]'), function (b) {
      b.addEventListener('click', function () { toggleLeave(b.getAttribute('data-leave'), true); });
    });
    Array.prototype.forEach.call($('report-leave-list').querySelectorAll('[data-unleave]'), function (b) {
      b.addEventListener('click', function () { toggleLeave(b.getAttribute('data-unleave'), false); });
    });
    notice('report-msg', '', 'info');
    adminScreen('report');
  }

  function toggleLeave(name, on) {
    var rec = state.report;
    if (!rec) return;
    rec.leaves = rec.leaves || [];
    var i = rec.leaves.indexOf(name);
    if (on && i < 0) rec.leaves.push(name);
    if (!on && i >= 0) rec.leaves.splice(i, 1);
    var h = state.history.filter(function (x) { return x.code === rec.code; })[0];
    if (h) { h.leaves = rec.leaves.slice(); saveHistory(); }
    buildReport(rec);
  }

  function flagTags(sub) {
    if (!sub || !sub.flags || !sub.flags.length) return '';
    var map = {
      off_roster: ['不在花名册', 'tag-gray'],
      far_away: ['距离偏离', 'tag-warn'],
      dup_name: ['同名重复', 'tag-bad'],
      same_device: ['同设备多填', 'tag-bad'],
      no_geo: ['未提供定位', 'tag-warn'],
      same_coord: ['与他人坐标完全相同', 'tag-bad'],
      geo_suspect: ['定位精度异常', 'tag-bad'],
      sig_same: ['设备特征与他人完全相同', 'tag-bad'],
      ip_far: ['IP 与定位不符', 'tag-bad'],
      ip_vpn: ['疑似代理/VPN', 'tag-bad']
    };
    return sub.flags.map(function (f) {
      var m = map[f] || [f, 'tag-warn'];
      return '<span class="tag ' + m[1] + '">' + esc(m[0]) + '</span>';
    }).join('');
  }

  function bindReport() {
    if (bindReport.done) return;
    bindReport.done = true;
    $('btn-back-home').addEventListener('click', function () { renderHome(); adminScreen('home'); });
    $('btn-copy-leaves').addEventListener('click', function () {
      var rec = state.report;
      if (!rec) return;
      var prev = null;
      for (var i = state.history.length - 1; i >= 0; i--) {
        if (state.history[i].code !== rec.code) { prev = state.history[i]; break; }
      }
      if (!prev || !(prev.leaves || []).length) { notice('report-msg', '上次没有请假记录', 'warn'); return; }
      rec.leaves = rec.leaves || [];
      var n = 0;
      prev.leaves.forEach(function (nm) { if (rec.leaves.indexOf(nm) < 0) { rec.leaves.push(nm); n++; } });
      var h = state.history.filter(function (x) { return x.code === rec.code; })[0];
      if (h) { h.leaves = rec.leaves.slice(); saveHistory(); }
      buildReport(rec);
      notice('report-msg', '已复制上次的 ' + n + ' 名请假同学', 'ok');
    });
    $('btn-export-xlsx').addEventListener('click', function () { exportReport('xlsx'); });
    $('btn-export-csv').addEventListener('click', function () { exportReport('csv'); });
  }

  function reportRows() {
    var rec = state.report || {};
    var subs = rec.subs || [];
    var byName = {};
    subs.forEach(function (x) { if (!byName[x.name]) byName[x.name] = x; });
    var leaveSet = {};
    (rec.leaves || []).forEach(function (n) { leaveSet[n] = 1; });
    var rows = [];
    rows.push(['班级', state.profile.className, '房间号', state.profile.room]);
    rows.push(['课程', rec.course || '', '开始时间', fmt(rec.openedAt), '结束时间', rec.closedAt ? fmt(rec.closedAt) : '']);
    rows.push([]);
    rows.push(['学号', '姓名', '状态', '提交时间', '距离(米)', '标记', 'IP归属', '设备指纹', 'IP']);
    state.roster.forEach(function (st) {
      if (st.active === false) return;
      var sub = byName[st.name];
      var status = sub ? '已到' : (leaveSet[st.name] ? '请假' : '未到');
      rows.push([st.no || '', st.name, status,
        sub ? fmt(sub.t) : '', sub && sub.dist != null ? sub.dist : '',
        sub && sub.flags && sub.flags.length ? sub.flags.join('/') : '',
        sub ? (((sub.ipCity || '') + ' ' + (sub.ipIsp || '')).trim()) : '',
        sub && sub.fp ? sub.fp : '', sub && sub.ip ? sub.ip : '']);
    });
    var known = {};
    state.roster.forEach(function (st) { known[st.name] = 1; });
    Object.keys(byName).forEach(function (n) {
      if (known[n]) return;
      var sub = byName[n];
      rows.push(['', n, '不在花名册', fmt(sub.t), sub.dist != null ? sub.dist : '',
        sub.flags ? sub.flags.join('/') : '',
        ((sub.ipCity || '') + ' ' + (sub.ipIsp || '')).trim(), sub.fp || '', sub.ip || '']);
    });
    return rows;
  }

  async function exportReport(kind) {
    try { await ensureLib('xlsx'); } catch (e) { notice('report-msg', '表格库没加载出来（网络问题），可稍后重试导出', 'bad'); return; }
    var rec = state.report || {};
    var rows = reportRows();
    var name = (rec.course || '点名') + '_' + fmtFile(rec.openedAt);
    if (kind === 'csv') {
      var csv = rows.map(function (r) {
        return r.map(function (c) {
          var v = c == null ? '' : String(c);
          return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(',');
      }).join('\r\n');
      var rejCsv = (rec.rejects || []);
      if (rejCsv.length) {
        csv += '\r\n\r\n被挡下的提交（一部手机只能签一个名字）\r\n时间,姓名,设备指纹,原因,是否已放行\r\n' +
          rejCsv.map(function (x) {
            return [fmt(x.t), x.name, x.fp, '同一部手机已签过别人', x.releasedAt ? '已放行' : '未放行'].join(',');
          }).join('\r\n');
      }
      download(name + '.csv', new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
      return;
    }
    try {
      var ws = window.XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 18 }, { wch: 9 }, { wch: 20 }, { wch: 18 }, { wch: 26 }, { wch: 16 }];
      var wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, '点名');
      var rej2 = (rec.rejects || []);
      if (rej2.length) {
        var rrows = [['时间', '姓名', '设备指纹', '原因', '是否已放行']];
        rej2.forEach(function (x) {
          rrows.push([fmt(x.t), x.name, x.fp, '同一部手机已签过别人', x.releasedAt ? '已放行 ' + fmt(x.releasedAt) : '未放行']);
        });
        var ws2 = window.XLSX.utils.aoa_to_sheet(rrows);
        ws2['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 28 }, { wch: 22 }, { wch: 20 }];
        window.XLSX.utils.book_append_sheet(wb, ws2, '被挡记录');
      }
      var out = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      download(name + '.xlsx', new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) {
      notice('report-msg', '导出失败，可以试试导出 CSV', 'bad');
    }
  }

  /* ---------- 历史（本地 + 云端存档） ---------- */
  async function renderHistory() {
    var local = state.history.slice().reverse();
    $('hist-list').innerHTML = local.length ? local.map(function (s) {
      return '<li><span class="grow">' + esc((s.course || '点名') + ' <span class="tiny">' + fmt(s.openedAt) + '</span>') +
        '</span><span class="tiny">' + (s.subs ? s.subs.length : 0) + ' 人' +
        ((s.leaves || []).length ? ' · 请假 ' + s.leaves.length : '') + '</span>' +
        '<button class="btn btn-sm" data-local="' + esc(s.code) + '">名单</button></li>';
    }).join('') : '<li class="muted">这台手机上还没有点名记录</li>';
    Array.prototype.forEach.call($('hist-list').querySelectorAll('[data-local]'), function (b) {
      b.addEventListener('click', function () {
        var code = b.getAttribute('data-local');
        var rec = state.history.filter(function (x) { return x.code === code; })[0];
        if (rec) buildReport(rec);
      });
    });
    var res = await api('GET', 'api/history?' + qs());
    if (res.data && res.data.ok && res.data.sessions && res.data.sessions.length) {
      var have = {};
      state.history.forEach(function (x) { have[x.code] = 1; });
      var extra = res.data.sessions.filter(function (x) { return !have[x.code]; });
      if (extra.length) {
        $('hist-list').insertAdjacentHTML('beforeend',
          '<li class="muted" style="display:block;padding-top:14px">云端存档（本机没有，可点开查看）</li>' +
          extra.map(function (s) {
            return '<li><span class="grow">' + esc((s.course || '点名') + ' <span class="tiny">' + fmt(s.openedAt) + '</span>') +
              '</span><span class="tiny">' + (s.count || 0) + ' 人</span>' +
              '<button class="btn btn-sm" data-cloud="' + esc(s.code) + '">名单</button></li>';
          }).join(''));
        Array.prototype.forEach.call($('hist-list').querySelectorAll('[data-cloud]'), function (b) {
          b.addEventListener('click', async function () {
            var code = b.getAttribute('data-cloud');
            var r2 = await api('GET', 'api/report/' + code + '?' + qs());
            if (!r2.data || !r2.data.ok) return;
            var s = r2.data.session;
            buildReport({ code: s.code, course: s.course, openedAt: s.openedAt, closedAt: s.closedAt, subs: s.subs, leaves: [] });
          });
        });
      }
    }
  }

  function bindHistory() {
    if (bindHistory.done) return;
    bindHistory.done = true;
    $('btn-hist-back').addEventListener('click', function () { renderHome(); adminScreen('home'); });
  }

  /* ---------- 入口 ---------- */
  (function boot() {
    var m = (location.search.match(/[?&]s=([A-Za-z0-9]+)/) || [])[1];
    if (m) { initStudent(m.toUpperCase()); return; }

    show('boot', false);
    show('view-admin', true);
    bindSetup(); bindHome(); bindLive(); bindReport(); bindHistory(); bindRoster();

    var saved = LS.get('ck_profile', null);
    if (saved && saved.room && saved.pinKey) {
      state.profile = saved;
      showLock();
    } else {
      showSetup();
    }
  })();
})();
