import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp, verifyInitData, CATALOG } from '../server.mjs';

const token = 'test-only-token';
function signed({ time = Math.floor(Date.now() / 1000), id = 123 } = {}) {
  const p = new URLSearchParams({ auth_date: String(time), user: JSON.stringify({ id, first_name: 'Тест', username: 'tester' }), query_id: 'test' });
  const data = [...p].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return p.toString();
}
const valid = () => ({ initData: signed(), service: 'space', name: 'Тест', contact: '@tester', message: 'Хочу обсудить съёмку интервью', consent: true, date: '', requestId: '12345678-abcd-1234-abcd-123456789012' });
async function fixture(t, options = {}) {
  const server = createApp(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, post: (body, headers = {}) => fetch(`${base}/api/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}
test('Telegram signature rejects tampering, stale/future auth and duplicate fields', () => {
  assert.equal(verifyInitData(signed(), token).id, 123);
  assert.equal(verifyInitData(signed().replace('query_id=test', 'query_id=evil'), token), null);
  assert.equal(verifyInitData(signed({ time: 1 }), token), null);
  assert.equal(verifyInitData(signed({ time: Math.floor(Date.now() / 1000) + 90 }), token), null);
  assert.equal(verifyInitData(`${signed()}&auth_date=1`, token), null);
  assert.equal(verifyInitData(signed(), 'wrong-token'), null);
});
test('static preview works without secrets; config does not leak credentials', async t => {
  const { base, post } = await fixture(t);
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await post(valid())).status, 503);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config, { bookingEnabled: false, botUsername: '' });
});
test('requests require signed auth, consent, valid service and same origin', async t => {
  let sent = 0;
  const { post, base } = await fixture(t, { env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ADMIN_CHAT_ID: '123' }, send: async () => { sent++; return 1; } });
  assert.equal((await post({ ...valid(), initData: '' })).status, 401);
  assert.equal((await post({ ...valid(), consent: false })).status, 400);
  assert.equal((await post({ ...valid(), service: 'unknown' })).status, 400);
  assert.equal((await post({ ...valid(), date: '2030-02-31' })).status, 400);
  assert.equal((await post(valid(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal(sent, 0);
  const config = await (await fetch(`${base}/api/config`)).text();
  assert.ok(!config.includes(token));
});
test('concurrent retries deliver once and reject altered payload under same id', async t => {
  let sent = 0, delivered = '';
  const { post } = await fixture(t, { env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ADMIN_CHAT_ID: '123' }, send: async (_token, _chat, text) => { sent++; delivered = text; await new Promise(r => setTimeout(r, 25)); return 10; } });
  const responses = await Promise.all([post(valid()), post(valid())]);
  for (const response of responses) { assert.equal(response.status, 200); assert.equal((await response.json()).delivered, true); }
  assert.equal(sent, 1); assert.match(delivered, /Пространство/); assert.match(delivered, /Telegram ID: 123/);
  assert.equal((await post({ ...valid(), message: 'Другая задача для той же заявки' })).status, 409);
});
test('failed delivery never returns success or exposes token; retry can succeed', async t => {
  let fail = true;
  const { post } = await fixture(t, { env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ADMIN_CHAT_ID: '123' }, send: async () => { if (fail) throw new Error(token); return 5; } });
  const response = await post(valid());
  assert.equal(response.status, 502); assert.ok(!(await response.text()).includes(token));
  fail = false; assert.equal((await post(valid())).status, 200);
});
test('rate limit blocks a fourth new request in ten minutes', async t => {
  const { post } = await fixture(t, { env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ADMIN_CHAT_ID: '123' }, send: async () => 1 });
  for (let i = 0; i < 3; i++) assert.equal((await post({ ...valid(), requestId: `unique-request-id-${i}` })).status, 200);
  assert.equal((await post({ ...valid(), requestId: 'unique-request-id-4' })).status, 429);
});

test('catalog preserves expected items and states without internal notes', async t => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/catalog`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('private_note'));
  const data = JSON.parse(text);
  assert.equal(data.items.filter(i => i.kind === 'equipment').length, 55);
  assert.equal(data.items.filter(i => i.kind === 'equipment' && i.status === 'soon').length, 26);
  assert.equal(data.items.filter(i => i.kind === 'course' && i.status === 'closed').length, 8);
  assert.equal(data.items.filter(i => i.kind === 'course' && i.status === 'soon').length, 2);
  assert.equal(data.items.filter(i => i.kind === 'service').length, 58);
  assert.equal(new Set(data.items.map(i => i.id)).size, data.items.length);
  assert.ok(data.items.every(i => data.categories[i.category]));
});

test('selected products are validated and names come from server catalog', async t => {
  let sent = 0, delivered = '';
  const { post } = await fixture(t, { env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ADMIN_CHAT_ID: '123' }, send: async (_t, _c, text) => { sent++; delivered = text; return 3; } });
  assert.equal((await post({ ...valid(), selection: [{ id: 'made-up-camera', quantity: 1 }] })).status, 400);
  const camera = CATALOG.items.find(i => i.kind === 'equipment' && i.title.includes('Pocket Cinema'));
  const course = CATALOG.items.find(i => i.kind === 'course' && i.status === 'closed');
  assert.equal((await post({ ...valid(), selection: [{ id: camera.id, quantity: camera.quantity + 1 }] })).status, 400);
  assert.equal((await post({ ...valid(), selection: [{ id: course.id, quantity: 2 }] })).status, 400);
  assert.equal((await post({ ...valid(), selection: [{ id: camera.id, quantity: 1 }, { id: camera.id, quantity: 1 }] })).status, 400);
  assert.equal(sent, 0);
  const response = await post({ ...valid(), selection: [{ id: camera.id, quantity: 2, title: 'INJECTED NAME', price: 1 }, { id: course.id, quantity: 1 }] });
  assert.equal(response.status, 200);
  assert.ok(delivered.includes(`2 × ${camera.title}`));
  assert.ok(delivered.includes('интерес к следующему набору'));
  assert.ok(!delivered.includes('INJECTED NAME'));
  assert.ok(delivered.length <= 4096);
});

test('selections include upcoming equipment as interest and enforce ten-item cap', async t => {
  let text = '';
  const { post } = await fixture(t, { env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ADMIN_CHAT_ID: '123' }, send: async (_t, _c, value) => { text = value; return 5; } });
  const soon = CATALOG.items.find(i => i.kind === 'equipment' && i.status === 'soon');
  const tooMany = CATALOG.items.slice(0, 11).map(item => ({ id: item.id, quantity: 1 }));
  assert.equal((await post({ ...valid(), selection: tooMany })).status, 400);
  assert.equal((await post({ ...valid(), selection: [{ id: soon.id, quantity: 1 }] })).status, 200);
  assert.match(text, /ожидается, интерес к поступлению/);
});
