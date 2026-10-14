/**
 * 课堂点名 · 自建后端（零依赖，单端口）
 * 职责：
 *  1) 托管前端静态文件（同学端签到页 + 班长端）
 *  2) 点名场次与提交的收集、校验、标黄 —— 全部在服务端判定
 * 说明：花名册不上传，留在班长手机里比对；服务端只做「谁在什么时候提交了什么」。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;
const VERSION = '2.1.0';
// 同设备冷却：默认 10,000,000 秒（≈115 天）。因为冷却按场次判定，实际效果 = 「本节课这台设备签完就结束」，
// 且「放行」一次后可再签一个名字，之后本场次内彻底锁死。下一节课（新场次）不受影响。
const COOLDOWN_MS = Math.max(3000, Number(process.env.CHECKIN_COOLDOWN_MS) || 10000000000);
const COOLDOWN_TEXT = COOLDOWN_MS >= 3600000
  ? '本次点名这台设备已经签到过了（如需代签，请班长点「放行」）'
  : '同一台设备两次签到要间隔 ' + Math.round(COOLDOWN_MS / 1000) + ' 秒，请稍等';

/* ---------------- 存储（落盘，进程重启不丢） ---------------- */
function pickDataDir() {
  const cands = [
    process.env.CHECKIN_DATA_DIR,
    path.join(os.homedir(), '.classcheckin'),
    path.join(ROOT, 'data')
  ].filter(Boolean);
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch (e) { /* 试下一个 */ }
  }
  return ROOT;
}
const DATA_DIR = pickDataDir();
const DB_FILE = path.join(DATA_DIR, 'db.json');
const LOG_FILE = path.join(DATA_DIR, 'checkin.jsonl');

let db = { rooms: {} };
try {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (raw && typeof raw === 'object' && raw.rooms) db = raw;
} catch (e) { /* 首次运行 */ }

let dirty = false;
function save() {
  dirty = true;
  clearTimeout(save.t);
  save.t = setTimeout(flush, 400);
}
function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { /* 磁盘问题不阻塞点名 */ }
}
setInterval(flush, 5000);
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

function appendLog(obj) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\n'); } catch (e) {}
}

/* ---------------- 工具 ---------------- */
const CN_NAME = /^[\u4e00-\u9fa5·]{2,10}$/;
const CODE_CHARS = 'ACDEFGHJKLMNPQRTUVWXY34679';

function genCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!findSession(s, null)) return s;
  }
  return Date.now().toString(36).toUpperCase().slice(-6);
}

function roomOf(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  if (!db.rooms[key]) db.rooms[key] = { sessions: [] };
  return db.rooms[key];
}

function findSession(code, roomName) {
  const up = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const rooms = roomName ? [String(roomName)] : Object.keys(db.rooms);
  for (const r of rooms) {
    const room = db.rooms[r];
    if (!room) continue;
    for (const s of room.sessions) {
      if (s.code === up) return { roomName: r, room: room, session: s };
    }
  }
  return null;
}

function pinKey(room, pin) {
  return crypto.createHash('sha256').update(String(room) + '|' + String(pin)).digest('hex').slice(0, 32);
}

function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.pow(Math.sin(dLng / 2), 2);
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function numOrNull(v, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  if (n === 0) return null; // 0,0 只会是「拿不到定位」的默认值，不是真实坐标
  return n;
}

/* ---------------- IP 归属地 / 机房代理判定（第二路独立校验） ---------------- */
const IP_LOOKUP = process.env.CHECKIN_IP_LOOKUP !== '0';
const IP_CACHE = new Map();
const IP_TTL = 6 * 3600 * 1000;
// 关键词命中即视为「机房/代理出口」——免费服务没有 security 字段，只能用 ISP/ASN 组织名判断
const IP_HOSTING_RE = /(vpn|proxy|hosting|datacenter|data ?center|dedicated|colo|server|cloud|amazon|aws|google|microsoft|azure|digitalocean|linode|hetzner|ovh|vultr|leaseweb|m247|oracle|alibaba|tencent|cloudflare|nordvpn|expressvpn|surfshark|starlink)/i;
const PRIVATE_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1$|fc|fd|localhost$)/i;

async function ipGeo(ip) {
  if (!IP_LOOKUP || !ip || PRIVATE_RE.test(ip)) return null;
  const hit = IP_CACHE.get(ip);
  if (hit && Date.now() - hit.at < IP_TTL) return hit.geo;
  let geo = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch('https://ipwho.is/' + encodeURIComponent(ip), { signal: ctl.signal });
    clearTimeout(timer);
    const j = await r.json();
    if (j && j.success !== false) {
      const c = j.connection || {};
      geo = {
        country: String(j.country || '').slice(0, 20),
        region: String(j.region || '').slice(0, 30),
        city: String(j.city || '').slice(0, 30),
        isp: String(c.isp || c.org || '').slice(0, 60),
        lat: typeof j.latitude === 'number' ? j.latitude : null,
        lng: typeof j.longitude === 'number' ? j.longitude : null
      };
    }
  } catch (e) {
    geo = null;
  }
  if (IP_CACHE.size > 800) IP_CACHE.clear();
  // 成功缓存 6 小时；失败缓存 1 分钟（避免频繁打接口）
  IP_CACHE.set(ip, { at: geo ? Date.now() : Date.now() - IP_TTL + 60000, geo: geo });
  return geo;
}

// 名单校验（可选）：班长端把「姓名哈希」上传，服务端只存哈希+随机盐，不存明文姓名。
// 这样服务端能判断"这个名字在不在名单里"，但看不到任何名字。
function applyRosterCheck(session, body) {
  const salt = String(body.nameSalt || '').slice(0, 32);
  const hashes = Array.isArray(body.nameHashes)
    ? body.nameHashes.map((h) => String(h).slice(0, 64)).filter(Boolean).slice(0, 400)
    : [];
  if (salt && hashes.length) {
    session.nameSalt = salt;
    session.nameHashes = hashes;
    return true;
  }
  return false;
}

function nameHashOf(session, name) {
  return crypto.createHash('sha256').update(session.nameSalt + '|' + name).digest('hex').slice(0, 32);
}

// 被挡下来的提交也要留证：这是「代刷企图」最直接的证据
// 同一台设备 + 同一个名字 + 同一个原因，60 秒内重复的合并计数，避免被刷爆
function recordReject(s, name, fp, reason) {
  if (!s.rejects) s.rejects = [];
  const t = Date.now();
  for (let i = s.rejects.length - 1; i >= 0 && i >= s.rejects.length - 20; i--) {
    const x = s.rejects[i];
    if (x.fp === fp && x.name === name && x.reason === reason && t - x.t < 60000) {
      x.n = (x.n || 1) + 1;
      x.t = t;
      x.at = nowIso();
      save();
      return;
    }
  }
  if (s.rejects.length > 200) s.rejects.shift();
  s.rejects.push({ name, fp, reason, t, at: nowIso(), n: 1 });
  save();
}

// 异步富化：绝不阻塞学生提交，结果随下一次轮询自动出现在班长端
function enrichSubmission(s, sub) {
  if (sub.ipTried) return;
  sub.ipTried = true;
  ipGeo(sub.ip).then((geo) => {
    if (!geo) return;
    sub.ipCountry = geo.country;
    sub.ipRegion = geo.region;
    sub.ipCity = geo.city;
    sub.ipIsp = geo.isp;
    sub.ipLat = geo.lat;
    sub.ipLng = geo.lng;
    if (geo.lat != null && geo.lng != null && sub.lat != null && sub.lng != null) {
      const gap = distance(geo.lat, geo.lng, sub.lat, sub.lng);
      sub.ipGap = gap;
      // 只在「定位在中国境内、而出口 IP 不在中国」时才标——这是强信号；
      // 同在国内只记距离做参考（运营商出口城市与教室城市不同很常见，不能当成作弊）
      if (inChina(sub.lat, sub.lng) && geo.country && geo.country !== 'China') {
        if (sub.flags.indexOf('ip_far') < 0) sub.flags.push('ip_far');
      }
    }
    if (IP_HOSTING_RE.test(geo.isp || '') && sub.flags.indexOf('ip_vpn') < 0) sub.flags.push('ip_vpn');
    save();
  }).catch(() => {});
}

function nowIso() { return new Date().toISOString(); }

// 中国大陆粗略包围盒：用于判断「定位在国内、出口 IP 在国外」这种强信号
function inChina(lat, lng) {
  return lat >= 18 && lat <= 54 && lng >= 73 && lng <= 135;
}

/* ---------------- HTTP ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > 200 * 1024) { over = true; req.destroy(); }
    });
    req.on('end', () => {
      if (over) return resolve(null);
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim().slice(0, 60);
  return String(req.socket.remoteAddress || '').slice(0, 60);
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/privacy' || p === '/privacy/') p = '/privacy.html';
  const full = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* ---------------- 业务 API ---------------- */
const api = {

  /* 建点名场次（班长端） */
  'POST /api/session': (req, res, body) => {
    const room = String((body && body.room) || '').trim();
    const key = String((body && body.pinKey) || '').trim();
    if (!room || key.length < 8) return sendJson(res, 400, { ok: false, message: '房间或口令不完整' });
    const r = roomOf(room);
    if (!r.pinKey) r.pinKey = key;
    if (r.pinKey !== key) return sendJson(res, 403, { ok: false, message: '房间口令不对' });
    // 同一房间已有未关闭的场次 → 直接复用
    const open = r.sessions.find((s) => s.status === 'open');
    if (open) {
      applyRosterCheck(open, body); // 复用场次时也同步一次名单哈希
      save();
      return sendJson(res, 200, { ok: true, reused: true, code: open.code, openedAt: open.openedAt });
    }
    const lat = numOrNull(body.lat, 90);
    const lng = numOrNull(body.lng, 180);
    const s = {
      code: genCode(),
      course: String(body.course || '').slice(0, 20),
      status: 'open',
      openedAt: nowIso(),
      closedAt: null,
      lat: lat,
      lng: lng,
      radius: Number(body.radius) || 200,
      subs: []
    };
    applyRosterCheck(s, body);
    r.sessions.push(s);
    if (r.sessions.length > 60) r.sessions = r.sessions.slice(-60);
    save();
    return sendJson(res, 200, { ok: true, code: s.code, openedAt: s.openedAt });
  },

  /* 场次状态（同学端，公开） */
  'GET /api/s/:code': (req, res, body, params) => {
    const hit = findSession(params.code, null);
    if (!hit) return sendJson(res, 200, { ok: false, status: 'invalid', message: '二维码无效，请让班长重新出示' });
    const s = hit.session;
    const names = new Set(s.subs.map((x) => x.name));
    return sendJson(res, 200, {
      ok: true,
      status: s.status === 'open' ? 'open' : 'closed',
      course: s.course || '',
      done: names.size
    });
  },

  /* 提交签到（同学端，公开） */
  'POST /api/checkin': (req, res, body) => {
    const name = String((body && body.name) || '').replace(/[\s\u3000]/g, '');
    if (!CN_NAME.test(name)) return sendJson(res, 200, { ok: false, status: 'bad_name', message: '请填写 2-10 个汉字的名字' });
    const hit = findSession(body.code, null);
    if (!hit) return sendJson(res, 200, { ok: false, status: 'invalid', message: '二维码无效，请让班长重新出示' });
    const s = hit.session;
    if (s.status !== 'open') return sendJson(res, 200, { ok: false, status: 'closed', message: '点名已结束' });

    // 名单校验：名单已上传时，不在名单里的名字直接拒收（陌生人/乱填的名字进不来）
    if (s.nameHashes && s.nameHashes.length) {
      if (s.nameHashes.indexOf(nameHashOf(s, name)) < 0) {
        recordReject(s, name, String(body.fp || '').slice(0, 120), 'not_in_roster');
        return sendJson(res, 200, { ok: false, status: 'not_in_roster', message: '这个名字不在班级名单里，请核对一下（或找班长）' });
      }
    }

    let fp = String((body.fp) || '').trim().slice(0, 120);
    const t = Date.now();
    // 注意：Number(null) === 0，必须显式区分「没上报精度」和「精度真的是 0」
    const acc = (body.acc === null || body.acc === undefined || body.acc === '')
      ? null
      : (Number.isFinite(Number(body.acc)) ? Number(body.acc) : null);
    const GEO_ERRS = ['denied', 'timeout', 'unavailable', 'unsupported'];
    const sub = {
      id: s.subs.length + 1,
      name,
      t,
      fp,
      ip: clientIp(req),
      ua: String(body.ua || '').slice(0, 200),
      lat: numOrNull(body.lat, 90),
      lng: numOrNull(body.lng, 180),
      acc: acc,
      sig: String(body.sig || '').slice(0, 64),
      geoErr: GEO_ERRS.indexOf(String(body.geoErr || '')) >= 0 ? String(body.geoErr) : null,
      dist: null,
      flags: []
    };

    let rel = null; // 班长放行记录（若本设备被放行过）
    if (fp) {
      const ids = Array.isArray(body.ids)
        ? body.ids.map((v) => String(v).slice(0, 40)).filter(Boolean).slice(0, 8)
        : [];
      // 这台设备用过的任何历史身份，只要在本场次签过 → 就是在清存储换身份
      const mine = s.subs.filter((x) => x.fp === fp || ids.some((id) => 'f' + id === x.fp));
      const same = mine.find((x) => x.name === name);
      if (same) {
        return sendJson(res, 200, {
          ok: true, status: 'already', name,
          position: new Set(s.subs.map((x) => x.name)).size,
          message: '你已经签到过了'
        });
      }
      // 硬拦：同一部设备（含被重置过身份的）在同一场次只能签一个名字，除非班长放过行
      const relOne = s.released && s.released[fp];
      rel = relOne;
      const exempt = relOne && !relOne.used; // 放行 = 班长手动豁免一次
      if (mine.length && !rel) {
        const reset = mine.some((x) => x.fp !== fp);
        recordReject(s, name, fp, reset ? 'id_reset' : 'device_used');
        return sendJson(res, 200, {
          ok: false,
          status: 'device_used',
          message: reset
            ? '这台设备之前已经替「' + mine[0].name + '」签过到了（检测到身份被重置）。请让班长在屏幕上点「放行」'
            : '这部手机已经替「' + mine[0].name + '」签过到了。一部手机只能签一个名字，请让班长在屏幕上点「放行」'
        });
      }
      const last = mine[mine.length - 1];
      if (!exempt && last && t - last.t < COOLDOWN_MS) {
        return sendJson(res, 200, { ok: false, status: 'too_fast', message: COOLDOWN_TEXT });
      }
      if (mine.length >= 4) sub.flags.push('same_device');
    }

    if (s.lat != null && s.lng != null && sub.lat != null && sub.lng != null) {
      sub.dist = distance(s.lat, s.lng, sub.lat, sub.lng);
      if (sub.dist > (s.radius || 200)) sub.flags.push('far_away');
    }
    // 场次有教室坐标，但这条没给定位（比如同学关掉了位置权限）→ 必须显式标出来，不能隐身
    if (s.lat != null && s.lng != null && (sub.lat == null || sub.lng == null)) {
      sub.flags.push('no_geo');
    }
    // 精度不合理（0 米或超大）→ 模拟定位的常见特征
    if (acc != null && (acc <= 0 || acc > 100000)) sub.flags.push('geo_suspect');

    // 坐标与别人完全相同 → 典型「同一台设备代人填同一组坐标」
    // 收窄条件：只在精度像真 GPS（≤30m）时判定；同坐标人数过多（>8）说明是网络定位的公共结果，不标
    if (sub.lat != null && sub.lng != null && acc != null && acc > 0 && acc <= 30) {
      const key = sub.lat.toFixed(5) + ',' + sub.lng.toFixed(5);
      const mates = s.subs.filter((x) => x.fp !== fp && x.lat != null && x.lng != null &&
        x.acc != null && x.acc > 0 && x.acc <= 30 &&
        x.lat.toFixed(5) + ',' + x.lng.toFixed(5) === key);
      if (mates.length && mates.length + 1 <= 8) {
        if (sub.flags.indexOf('same_coord') < 0) sub.flags.push('same_coord');
        mates.forEach((m) => { if (m.flags.indexOf('same_coord') < 0) m.flags.push('same_coord'); });
      }
    }

    const dup = s.subs.filter((x) => x.name === name && x.fp !== fp);
    if (dup.length) {
      sub.flags.push('dup_name');
      dup.forEach((x) => { if (x.flags.indexOf('dup_name') < 0) x.flags.push('dup_name'); });
    }

    // 属性指纹（屏幕/字体/渲染特征）与他人完全相同，但存储身份不同：
    // 可能是「清缓存/换浏览器/换隐身模式」再签一次，也可能是同款同配置机型。
    // 两种情形网页端无法区分 → 只标黄留证，绝不硬拦（硬拦会误杀用同款手机的同学）
    if (sub.sig) {
      const sigMates = s.subs.filter((x) => x.fp !== fp && x.sig && x.sig === sub.sig);
      if (sigMates.length) {
        if (sub.flags.indexOf('sig_same') < 0) sub.flags.push('sig_same');
        sigMates.forEach((m) => { if (m.flags.indexOf('sig_same') < 0) m.flags.push('sig_same'); });
      }
    }

    s.subs.push(sub);
    if (rel) rel.used = true; // 这次豁免用掉了，之后本场次再签仍会被冷却挡住
    save();
    enrichSubmission(s, sub);
    appendLog({ code: s.code, name, t: new Date(t).toISOString(), fp, ip: sub.ip, dist: sub.dist, flags: sub.flags });
    return sendJson(res, 200, {
      ok: true,
      status: 'ok',
      name,
      position: new Set(s.subs.map((x) => x.name)).size,
      flags: sub.flags,
      message: '签到成功'
    });
  },

  /* 实时提交（班长端轮询） */
  'GET /api/live/:code': (req, res, body, params, q) => {
    const hit = findSession(params.code, q.room);
    if (!hit) return sendJson(res, 404, { ok: false, message: '场次不存在' });
    if (hit.session.status === 'open' && hit.room.pinKey && q.pinKey !== hit.room.pinKey) {
      return sendJson(res, 403, { ok: false, message: '房间口令不对' });
    }
    const s = hit.session;
    return sendJson(res, 200, { ok: true, status: s.status, course: s.course, openedAt: s.openedAt, subs: s.subs, rejects: s.rejects || [], rosterCount: (s.nameHashes || []).length });
  },

  /* 结束点名 */
  'POST /api/close': (req, res, body) => {
    const room = String((body && body.room) || '').trim();
    const key = String((body && body.pinKey) || '').trim();
    const r = db.rooms[room];
    if (!r || (r.pinKey && r.pinKey !== key)) return sendJson(res, 403, { ok: false, message: '房间口令不对' });
    const s = r.sessions.find((x) => x.code === String(body.code || '').toUpperCase());
    if (!s) return sendJson(res, 404, { ok: false, message: '场次不存在' });
    if (s.status === 'open') { s.status = 'closed'; s.closedAt = nowIso(); save(); }
    return sendJson(res, 200, { ok: true, closedAt: s.closedAt, subs: s.subs, rejects: s.rejects || [], status: 'closed' });
  },

  /* 同步名单哈希（改过花名册后重新上传，服务端只存哈希） */
  'POST /api/roster': (req, res, body) => {
    const room = String((body && body.room) || '').trim();
    const key = String((body && body.pinKey) || '').trim();
    const r = db.rooms[room];
    if (!r || (r.pinKey && r.pinKey !== key)) return sendJson(res, 403, { ok: false, message: '房间口令不对' });
    const s = r.sessions.find((x) => x.code === String(body.code || '').toUpperCase());
    if (!s) return sendJson(res, 404, { ok: false, message: '场次不存在' });
    const applied = applyRosterCheck(s, body);
    save();
    return sendJson(res, 200, { ok: true, rosterCheck: !!applied, count: (s.nameHashes || []).length });
  },

  /* 放行：班长现场处理「两人共用一部手机」 */
  'POST /api/release': (req, res, body) => {
    const room = String((body && body.room) || '').trim();
    const key = String((body && body.pinKey) || '').trim();
    const r = db.rooms[room];
    if (!r || (r.pinKey && r.pinKey !== key)) return sendJson(res, 403, { ok: false, message: '房间口令不对' });
    const s = r.sessions.find((x) => x.code === String(body.code || '').toUpperCase());
    if (!s) return sendJson(res, 404, { ok: false, message: '场次不存在' });
    const fp = String(body.fp || '').slice(0, 120);
    if (!fp) return sendJson(res, 400, { ok: false, message: '缺少设备标识' });
    if (!s.released) s.released = {};
    s.released[fp] = { at: nowIso(), used: false }; // used=false：这次放行可以再用一次
    if (s.rejects) s.rejects.forEach((x) => { if (x.fp === fp && !x.releasedAt) x.releasedAt = nowIso(); });
    save();
    return sendJson(res, 200, { ok: true });
  },

  /* 历史（班长端） */
  'GET /api/history': (req, res, body, params, q) => {
    const r = db.rooms[String(q.room || '')];
    if (!r) return sendJson(res, 200, { ok: true, sessions: [] });
    if (r.pinKey && q.pinKey !== r.pinKey) return sendJson(res, 403, { ok: false, message: '房间口令不对' });
    const list = r.sessions.slice().reverse().map((s) => ({
      code: s.code, course: s.course, status: s.status,
      openedAt: s.openedAt, closedAt: s.closedAt,
      count: new Set(s.subs.map((x) => x.name)).size
    }));
    return sendJson(res, 200, { ok: true, sessions: list });
  },

  /* 单个场次明细（含留证，班长端） */
  'GET /api/report/:code': (req, res, body, params, q) => {
    const hit = findSession(params.code, q.room);
    if (!hit) return sendJson(res, 404, { ok: false, message: '场次不存在' });
    if (hit.room.pinKey && q.pinKey !== hit.room.pinKey) return sendJson(res, 403, { ok: false, message: '房间口令不对' });
    hit.session.subs.forEach((sub) => enrichSubmission(hit.session, sub));
    return sendJson(res, 200, { ok: true, session: hit.session });
  },

  'GET /api/ping': (req, res) => sendJson(res, 200, { ok: true, version: VERSION, dataDir: DATA_DIR })
};

/* ---------------- 入口 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  if (pathname.startsWith('/api/')) {
    const q = {};
    const qi = url.indexOf('?');
    if (qi >= 0) {
      for (const kv of url.slice(qi + 1).split('&')) {
        const i = kv.indexOf('=');
        if (i > 0) q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      }
    }
    const m = pathname.match(/^\/api\/(s|live|report)\/([A-Za-z0-9]+)$/);
    const params = m ? { code: m[2] } : {};
    const route = m ? (req.method + ' /api/' + m[1] + '/:code') : (req.method + ' ' + pathname);
    const handler = api[route];
    if (!handler) return sendJson(res, 404, { ok: false, message: '接口不存在' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (req.method === 'POST' && body === null) return sendJson(res, 400, { ok: false, message: '请求体格式错误' });
    try {
      return handler(req, res, body, params, q);
    } catch (e) {
      return sendJson(res, 500, { ok: false, message: '服务器出错' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return;
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[class-checkin] v' + VERSION + ' listening on ' + PORT + ' | data: ' + DATA_DIR);
});
