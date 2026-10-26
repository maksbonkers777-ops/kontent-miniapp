import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const CATALOG = JSON.parse(await readFile(new URL('./catalog.json', import.meta.url), 'utf8'));
const itemById = new Map(CATALOG.items.map(item => [item.id, item]));

export const SERVICES = Object.freeze({
  production: 'Продакшн', rental: 'Техника и рентал', space: 'Пространство', school: 'Контент-школа', events: 'Мероприятия', mixed: 'Несколько направлений'
});
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);

export function verifyInitData(raw, token, now = Math.floor(Date.now() / 1000)) {
  if (typeof raw !== 'string' || raw.length > 12000 || !token) return null;
  const params = new URLSearchParams(raw);
  if (new Set(params.keys()).size !== [...params.keys()].length) return null;
  const hash = params.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) return null;
  params.delete('hash');
  const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const date = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(date) || date < now - 3600 || date > now + 30) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return Number.isSafeInteger(user?.id) && user.id > 0 ? user : null;
  } catch { return null; }
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { service, name, contact, message, date = '', consent, requestId, selection = [] } = body;
  if (!Object.hasOwn(SERVICES, service) || consent !== true ||
      !/^[a-zA-Z0-9-]{16,64}$/.test(requestId || '')) return null;
  if (![name, contact, message, date].every(v => typeof v === 'string')) return null;
  if (name.trim().length < 2 || name.length > 80 || contact.trim().length < 3 ||
      contact.length > 120 || message.trim().length < 10 || message.length > 1500) return null;
  if (!Array.isArray(selection) || selection.length > 10) return null;
  const seen = new Set();
  const selected = [];
  for (const row of selection) {
    if (!row || typeof row.id !== 'string' || !Number.isSafeInteger(row.quantity)) return null;
    const item = itemById.get(row.id);
    if (!item || seen.has(row.id) || row.quantity < 1 || row.quantity > (item.kind === 'equipment' && item.status === 'catalog' ? (item.quantity || 20) : 1)) return null;
    seen.add(row.id);
    selected.push({ id: row.id, quantity: row.quantity });
  }
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        date < new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)) return null;
  }
  selected.sort((a, b) => a.id.localeCompare(b.id));
  return { service, name: name.trim(), contact: contact.trim(), message: message.trim(), date, requestId, selection: selected };
}

async function telegramSend(token, chatId, text) {
  // Do not log fetch errors: their URL can contain the bot token.
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.result?.message_id) throw new Error('DELIVERY_FAILED');
  return result.result.message_id;
}

export function createApp({ env = process.env, send = telegramSend } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN || '';
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID || '';
  const ready = Boolean(token && /^-?\d+$/.test(chatId));
  const botUsername = /^[a-zA-Z0-9_]{5,32}$/.test(env.BOT_USERNAME || '') ? env.BOT_USERNAME : '';
  const records = new Map(), limits = new Map();
  let lastCleanup = 0;

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') return json(200, { status: 'ok', version: CATALOG.version });
      if (req.method === 'GET' && path === '/api/config') return json(200, { bookingEnabled: ready, botUsername });
      if (req.method === 'GET' && path === '/api/catalog') return json(200, CATALOG);
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const data = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(data);
      }
      if (path !== '/api/requests' || req.method !== 'POST') return json(404, { error: 'Страница не найдена.' });
      if (!ready) return json(503, { error: 'Приём заявок пока не подключён. Попробуйте позже.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'Неверный формат запроса.' });
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { return json(403, { error: 'Недопустимый источник.' }); }
        if (origin.host !== req.headers.host) return json(403, { error: 'Недопустимый источник.' });
      }
      let size = 0, chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20000) return json(413, { error: 'Заявка слишком большая.' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return json(400, { error: 'Не удалось прочитать заявку.' }); }
      const user = verifyInitData(body.initData, token);
      if (!user) return json(401, { error: 'Откройте приложение заново через кнопку меню бота в Telegram.' });
      const booking = validate(body);
      if (!booking) return json(400, { error: 'Проверьте поля заявки и согласие на передачу данных.' });
      const now = Date.now();
      if (now - lastCleanup > 60000) {
        for (const [k, v] of records) if (now - v.time > 3600000) records.delete(k);
        for (const [k, v] of limits) if (now - v.start > 600000) limits.delete(k);
        lastCleanup = now;
      }
      const key = `${user.id}:${booking.requestId}`;
      const fingerprint = JSON.stringify(booking);
      const previous = records.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return json(409, { error: 'Данные заявки изменились. Повторите отправку.' });
        const id = await previous.promise;
        return json(200, { ok: true, reference: booking.requestId.slice(0, 8).toUpperCase(), delivered: Boolean(id) });
      }
      const limit = limits.get(user.id);
      if (limit && now - limit.start < 600000 && limit.count >= 3) return json(429, { error: 'Вы уже отправили несколько заявок. Попробуйте через 10 минут.' });
      limits.set(user.id, limit && now - limit.start < 600000 ? { ...limit, count: limit.count + 1 } : { start: now, count: 1 });
      const text = [
        'КОНТЕНТ.ART · Новая заявка', `Номер: ${booking.requestId}`,
        `Направление: ${SERVICES[booking.service]}`, `Имя: ${booking.name}`,
        `Контакт: ${booking.contact}`, `Желаемая дата: ${booking.date || 'Обсудить'}`,
        booking.selection.length ? 'Выбрано из каталога:\n' + booking.selection.map(row => {
          const item = itemById.get(row.id);
          const state = item.status === 'soon' ? 'ожидается, интерес к поступлению' : item.status === 'closed' ? 'интерес к следующему набору' : item.status === 'review' ? 'модель уточняется' : 'требует подтверждения';
          return `• ${row.quantity} × ${item.title} (${state})`;
        }).join('\n') : '',
        `Задача: ${booking.message}`, `Telegram ID: ${user.id}`,
        user.username ? `Telegram: @${String(user.username).slice(0, 32)}` : '',
        'Пользователь согласился передать эти данные команде для ответа на заявку.'
      ].filter(Boolean).join('\n\n');
      const promise = Promise.resolve().then(() => send(token, chatId, text));
      records.set(key, { promise, fingerprint, time: now });
      try { await promise; }
      catch { records.delete(key); return json(502, { error: 'Не удалось подтвердить доставку. Повторите позже; при повторе у заявки сохранится тот же номер.' }); }
      return json(200, { ok: true, reference: booking.requestId.slice(0, 8).toUpperCase(), delivered: true });
    } catch {
      if (!res.headersSent) return json(500, { error: 'Не удалось обработать запрос. Попробуйте позже.' });
      res.end();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createApp();
  server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log('КОНТЕНТ.ART ready'));
  server.requestTimeout = 20000;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
