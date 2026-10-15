// 反作弊与工具函数的单元测试（node --test）
// 跑法： cd app && npm test
const os = require('node:os');
const path = require('node:path');
process.env.CHECKIN_DATA_DIR = path.join(os.tmpdir(), 'classcheckin-test-' + Date.now());
process.env.CHECKIN_MAX_ROOMS = '25';
process.env.CHECKIN_XFF = 'on';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const S = require('../server.js');

const fakeReq = (ip) => ({ headers: {}, socket: { remoteAddress: ip || '9.9.9.9' } });

test('distance：算得准（杭州→上海约 170 公里）', () => {
  const d = S.distance(30.2741, 120.1551, 31.2304, 121.4737);
  assert.ok(d > 150000 && d < 200000, '实际 ' + d);
  assert.strictEqual(S.distance(30.2741, 120.1551, 30.2741, 120.1551), 0);
});

test('numOrNull：null / 空串 / 0 都当"没有坐标"，非法值不通过', () => {
  assert.strictEqual(S.numOrNull(null, 90), null);
  assert.strictEqual(S.numOrNull(undefined, 90), null);
  assert.strictEqual(S.numOrNull('', 90), null);
  assert.strictEqual(S.numOrNull(0, 90), null);   // 0 只会是"拿不到定位"的默认值
  assert.strictEqual(S.numOrNull('30.5', 90), 30.5);
  assert.strictEqual(S.numOrNull(91, 90), null);  // 超出纬度范围
  assert.strictEqual(S.numOrNull('abc', 90), null);
});

test('inChina：只用来判"定位在国内、出口 IP 在国外"这个强信号', () => {
  assert.strictEqual(S.inChina(30.27, 120.15), true);
  assert.strictEqual(S.inChina(35.68, 139.69), false); // 东京
});

test('CN_NAME：汉字（含扩展区生僻字）与间隔号通过，拉丁/数字/单字不通过', () => {
  const ok = ['张伟', '欧阳娜娜', '穆罕默德·阿卜杜拉·艾山', '𠀀𠀁'];
  const bad = ['A', '张1', '张', '张伟a', '张 伟'.replace(' ', '') + '!', 'a'.repeat(3)];
  ok.forEach((n) => assert.ok(S.CN_NAME.test(n), '应通过: ' + n));
  bad.forEach((n) => assert.ok(!S.CN_NAME.test(n), '应拒绝: ' + n));
});

test('名单哈希校验：在名单里能对上，陌生人一定对不上', () => {
  const salt = 'testsalt';
  const h = (n) => crypto.createHash('sha256').update(salt + '|' + n).digest('hex').slice(0, 32);
  const session = {};
  const applied = S.applyRosterCheck(session, { nameSalt: salt, nameHashes: [h('张伟'), h('李明')] });
  assert.strictEqual(applied, true);
  assert.ok(session.nameHashes.indexOf(S.nameHashOf(session, '张伟')) >= 0);
  assert.ok(session.nameHashes.indexOf(S.nameHashOf(session, '孙悟空')) < 0);
});

test('applyRosterCheck：没给盐或名单为空时不开校验（向后兼容旧客户端）', () => {
  assert.strictEqual(S.applyRosterCheck({}, { nameHashes: ['a'.repeat(32)] }), false);
  assert.strictEqual(S.applyRosterCheck({}, { nameSalt: 's', nameHashes: [] }), false);
});

test('trimSessions：超出保留上限就丢最旧的（云端不是永久保存）', () => {
  const r = { sessions: [] };
  for (let i = 0; i < S.KEEP_SESSIONS + 10; i++) r.sessions.push({ code: 'C' + i });
  S.trimSessions(r);
  assert.strictEqual(r.sessions.length, S.KEEP_SESSIONS);
  assert.strictEqual(r.sessions[r.sessions.length - 1].code, 'C' + (S.KEEP_SESSIONS + 9));
});

test('限流：连续刷建房接口会被挡下', () => {
  const lim = { windowMs: 60000, max: 3 };
  const results = [];
  for (let i = 0; i < 5; i++) results.push(S.rateLimited(fakeReq('7.7.7.7'), lim));
  assert.deepStrictEqual(results, [false, false, false, true, true]);
});

test('pinOf：请求头优先，query 作为兼容兜底', () => {
  assert.strictEqual(S.pinOf({ headers: { 'x-pin-key': 'HEADER' } }, { pinKey: 'QUERY' }), 'HEADER');
  assert.strictEqual(S.pinOf({ headers: {} }, { pinKey: 'QUERY' }), 'QUERY');
  assert.strictEqual(S.pinOf({ headers: {} }, {}), '');
});

test('genCode：6 位、只用不易混淆的字符', () => {
  for (let i = 0; i < 20; i++) {
    const c = S.genCode();
    assert.strictEqual(c.length, 6);
    assert.ok(/^[ACDEFGHJKLMNPQRTUVWXY34679]+$/.test(c), c);
  }
});

test('roomOf：房间数达上限时淘汰最久没点名的房间（防刷爆磁盘）', () => {
  const first = S.roomOf('room-0');
  assert.ok(first);
  // 造出比上限更多的房间
  for (let i = 1; i <= S.MAX_ROOMS + 5; i++) S.roomOf('room-' + i);
  const rooms = Object.keys(S._db().rooms);
  assert.ok(rooms.length <= S.MAX_ROOMS, '房间数应被限制，实际 ' + rooms.length);
});
