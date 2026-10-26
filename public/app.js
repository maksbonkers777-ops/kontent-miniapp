const tg = window.Telegram?.WebApp;
const form = document.querySelector('#request-form');
const status = document.querySelector('#form-status');
const submit = document.querySelector('#submit');
const connection = document.querySelector('#connection');
let configuration, busy = false, requestId = crypto.randomUUID();
const hasTelegram = Boolean(tg?.initData);

try {
  tg?.ready(); tg?.expand(); tg?.setHeaderColor('#111210'); tg?.setBackgroundColor('#111210');
  tg?.setBottomBarColor?.('#181a16');
} catch { /* Older Telegram clients can omit newer UI methods. */ }

function route() {
  let page = location.hash.slice(1) || 'home';
  if (!['home', 'services', 'request', 'about', 'privacy'].includes(page)) page = 'home';
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== page; });
  document.querySelectorAll('.bottom-nav a').forEach(link => {
    if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (page === 'home') tg?.BackButton?.hide(); else tg?.BackButton?.show();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
tg?.BackButton?.onClick(() => { location.hash = location.hash === '#privacy' ? 'request' : 'home'; });
document.addEventListener('click', event => {
  const target = event.target.closest('[data-go], [data-service]');
  if (!target) return;
  if (target.dataset.service) {
    form.elements.service.value = target.dataset.service;
    requestId = crypto.randomUUID();
    location.hash = 'request';
  } else location.hash = target.dataset.go;
});
form.addEventListener('input', () => {
  requestId = crypto.randomUUID(); status.textContent = ''; status.className = 'form-status';
});
form.elements.date.min = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
if (hasTelegram) {
  // Convenience only. The server authenticates the signed initData independently.
  form.elements.name.value = [tg.initDataUnsafe?.user?.first_name, tg.initDataUnsafe?.user?.last_name].filter(Boolean).join(' ').slice(0, 80);
  if (tg.initDataUnsafe?.user?.username) form.elements.contact.value = `@${tg.initDataUnsafe.user.username}`;
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error();
    configuration = await response.json();
    if (!hasTelegram) {
      connection.textContent = 'Это просмотр в браузере. Для отправки заявки открой приложение через кнопку меню бота в Telegram.';
      if (configuration.botUsername) {
        const link = document.querySelector('#telegram-link');
        link.href = `https://t.me/${configuration.botUsername}`;
        link.hidden = false;
      }
    } else if (!configuration.bookingEnabled) {
      connection.textContent = 'Приём заявок ещё не подключён. Загляни позже.';
    } else {
      connection.textContent = 'Ты в Telegram. Можно отправить заявку команде.';
      connection.classList.add('ready'); submit.disabled = false;
    }
  } catch { connection.textContent = 'Не удалось подключиться. Обнови страницу, чтобы попробовать снова.'; }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !hasTelegram || !configuration?.bookingEnabled || !form.reportValidity()) return;
  busy = true; submit.disabled = true; submit.textContent = 'Отправляем…';
  status.textContent = ''; status.className = 'form-status';
  const fields = new FormData(form);
  const payload = Object.fromEntries(fields);
  payload.consent = fields.has('consent'); payload.initData = tg.initData; payload.requestId = requestId;
  // Lock fields until delivery completes so visible data matches the submitted request.
  [...form.elements].forEach(element => { element.disabled = true; });
  try {
    const response = await fetch('/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(25000)
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || result.delivered !== true) throw new Error(result.error || 'Не удалось подтвердить отправку. Попробуй позже.');
    form.reset(); requestId = crypto.randomUUID();
    status.className = 'form-status success';
    status.textContent = `Заявка № ${result.reference} доставлена команде. Ответим по указанному контакту. Дата и условия пока не подтверждены.`;
    tg?.HapticFeedback?.notificationOccurred('success');
  } catch (error) {
    status.className = 'form-status error';
    status.textContent = error.name === 'TimeoutError' || error.name === 'TypeError'
      ? 'Не удалось подтвердить доставку. Проверь интернет и повтори отправку. У заявки сохранится тот же номер.'
      : error.message;
  } finally {
    busy = false; [...form.elements].forEach(element => { element.disabled = false; });
    submit.disabled = !hasTelegram || !configuration?.bookingEnabled;
    submit.innerHTML = 'Отправить заявку <span>↗</span>';
  }
});
route(); loadConfig();
