const tg = window.Telegram?.WebApp;
const form = document.querySelector('#request-form');
const status = document.querySelector('#form-status');
const submit = document.querySelector('#submit');
const connection = document.querySelector('#connection');
let configuration, busy = false, requestId = crypto.randomUUID();
let catalog;
const selected = new Map();
const hasTelegram = Boolean(tg?.initData);

try {
  tg?.ready(); tg?.expand(); tg?.setHeaderColor('#111210'); tg?.setBackgroundColor('#111210');
  tg?.setBottomBarColor?.('#181a16');
} catch { /* Older Telegram clients can omit newer UI methods. */ }

function route() {
  let page = location.hash.slice(1) || 'home';
  if (!['home', 'equipment', 'school', 'services', 'request', 'about', 'privacy'].includes(page)) page = 'home';
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
  const target = event.target.closest('[data-go], [data-service], [data-catalog]');
  if (!target) return;
  if (target.dataset.catalog) {
    const select = document.querySelector(`#${target.dataset.catalog} .category-filter`);
    if (select) {
      const mount = select.closest('.catalog-mount');
      mount.querySelector('.catalog-search').value = '';
      mount.querySelector('.status-filter').value = '';
      select.value = target.dataset.category || '';
      renderCatalog(mount);
    }
    location.hash = target.dataset.catalog;
  } else if (target.dataset.service) {
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
  payload.selection = [...selected].map(([id, quantity]) => ({ id, quantity }));
  // Lock fields until delivery completes so visible data matches the submitted request.
  [...form.elements].forEach(element => { element.disabled = true; });
  try {
    const response = await fetch('/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(25000)
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || result.delivered !== true) throw new Error(result.error || 'Не удалось подтвердить отправку. Попробуй позже.');
    form.reset(); selected.clear(); renderSelection(); refreshCatalogs(); requestId = crypto.randomUUID();
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
const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const money = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value) + ' ₽';
const statuses = { catalog: 'По запросу', soon: 'Скоро', closed: 'Набор закрыт', review: 'Модель уточняется', inquiry: 'Условия уточняются' };
const kindTitle = { equipment: 'Техника', course: 'Обучение', service: 'Услуги' };
const maxQuantity = item => item.kind === 'equipment' && item.status === 'catalog' ? (item.quantity || 20) : 1;
function priceText(item) {
  return item.price ? `${item.priceFrom ? 'от ' : ''}${money(item.price)}` : 'Стоимость по запросу';
}
function details(item) {
  const lines = [];
  if (item.duration) lines.push(`<p>${escapeHTML(item.duration)}${item.seats ? ` · до ${item.seats} человек` : ''}</p>`);
  if (item.format) lines.push(`<p>${escapeHTML(item.format)}</p>`);
  for (const [key, heading] of [['kit','Комплектация'],['specs','Характеристики'],['program',item.kind === 'course' ? 'Программа' : 'Что входит']]) {
    if (item[key]) lines.push(`<h3>${heading}</h3><ul>${item[key].split('\n').map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ul>`);
  }
  if (item.kind === 'equipment') lines.push(`<p>${item.quantity ? `${item.status === 'soon' ? 'Ожидается' : 'По инвентарю'}: ${item.quantity} ${item.title.includes('Kit') || item.title.includes('SYNCO') ? 'компл.' : 'шт.'} · даты проверим по заявке.` : 'Количество уточняется.'}</p>`);
  if (item.note) lines.push(`<p class="muted">${escapeHTML(item.note)}</p>`);
  return lines.length ? `<details><summary>${item.kind === 'course' ? 'Программа и формат' : 'Подробнее'}</summary><div class="item-details">${lines.join('')}</div></details>` : '';
}
function renderCatalog(mount) {
  if (!catalog || !mount) return;
  const query = mount.querySelector('.catalog-search').value.trim().toLocaleLowerCase('ru');
  const category = mount.querySelector('.category-filter').value;
  const state = mount.querySelector('.status-filter').value;
  const items = catalog.items.filter(item => item.kind === mount.dataset.kind &&
    (!query || `${item.title} ${item.description} ${catalog.categories[item.category]}`.toLocaleLowerCase('ru').includes(query)) &&
    (!category || item.category === category) && (!state || item.status === state));
  mount.querySelector('.result-count').textContent = `Найдено: ${items.length}`;
  mount.querySelector('.catalog-grid').innerHTML = items.length ? items.map(item => {
    const added = selected.has(item.id);
    const action = item.status === 'soon' ? (item.kind === 'equipment' ? 'Узнать о поступлении' : 'Узнать о запуске') : item.status === 'closed' ? 'Интересен следующий набор' : item.status === 'review' ? 'Уточнить модель' : 'Добавить в заявку';
    return `<article class="catalog-card ${item.status === 'soon' ? 'is-soon' : ''}">
      <div class="item-meta"><span>${escapeHTML(catalog.categories[item.category] || item.category)}</span><span class="item-status">${statuses[item.status]}</span></div>
      <h2>${escapeHTML(item.title)}</h2><p class="item-description">${escapeHTML(item.description)}</p>
      ${details(item)}
      <div class="item-price"><strong>${priceText(item)}</strong>${item.price ? `<span>${escapeHTML(item.unit || 'проект')} · ориентир</span>` : ''}</div>
      <button type="button" class="outline add-item ${added ? 'added' : ''}" data-add="${escapeHTML(item.id)}" ${added ? 'disabled' : ''}>${added ? 'Добавлено ✓' : action+' ↗'}</button>
    </article>`;
  }).join('') : '<div class="empty-state"><h2>Ничего не нашлось</h2><p>Попробуй другое название или сбрось фильтры.</p><button type="button" class="outline" data-reset>Сбросить фильтры</button></div>';
}
function refreshCatalogs() { document.querySelectorAll('.catalog-mount').forEach(renderCatalog); }
function announce(text) {
  let message = document.querySelector('#catalog-feedback');
  if (!message) { message = document.createElement('p'); message.id = 'catalog-feedback'; message.className = 'catalog-feedback'; message.setAttribute('role', 'status'); document.querySelector('.shell').append(message); }
  message.textContent = text;
}
function renderSelection() {
  if (!catalog) return;
  const count = [...selected.values()].reduce((a, b) => a + b, 0);
  const badge = document.querySelector('#selection-count');
  badge.textContent = count; badge.hidden = !count;
  document.querySelector('#clear-selection').hidden = !count;
  document.querySelector('#selection-summary').innerHTML = !count ? '<p class="muted">Можно отправить общую заявку или выбрать позиции в каталоге.</p>' : [...selected].map(([id, quantity]) => {
    const item = catalog.items.find(row => row.id === id);
    return `<article class="selected-item"><div><strong>${escapeHTML(item.title)}</strong><p>${statuses[item.status]} · ${priceText(item)}${item.price ? ` / ${escapeHTML(item.unit || 'проект')}` : ''}</p></div><div class="quantity-controls"><button type="button" data-quantity="${escapeHTML(id)}" data-delta="-1" aria-label="Уменьшить количество: ${escapeHTML(item.title)}">−</button><span aria-label="Количество">${quantity}</span><button type="button" data-quantity="${escapeHTML(id)}" data-delta="1" ${quantity >= maxQuantity(item) ? 'disabled' : ''} aria-label="Увеличить количество: ${escapeHTML(item.title)}">+</button><button type="button" data-remove="${escapeHTML(id)}" aria-label="Убрать: ${escapeHTML(item.title)}">×</button></div></article>`;
  }).join('') + '<p class="muted selection-note">Это список пожеланий, не бронь и не счёт. Наличие, даты, скидки за комплект и итоговую сумму подтвердим лично. До 10 разных позиций в одной заявке.</p>';
  const kinds = new Set([...selected.keys()].map(id => catalog.items.find(item => item.id === id).kind));
  if (kinds.size > 1) form.elements.service.value = 'mixed';
  else if (kinds.has('equipment')) form.elements.service.value = 'rental';
  else if (kinds.has('course')) form.elements.service.value = 'school';
  else if (kinds.has('service')) form.elements.service.value = 'production';
  requestId = crypto.randomUUID();
}
async function loadCatalog() {
  try {
    const response = await fetch('/api/catalog');
    if (!response.ok) throw new Error();
    catalog = await response.json();
    document.querySelector('#catalog-stats').innerHTML = ['equipment','course','service'].map(kind => `<span><strong>${catalog.items.filter(item => item.kind === kind).length}</strong>${kindTitle[kind]}</span>`).join('');
    for (const mount of document.querySelectorAll('.catalog-mount')) {
      const kind = mount.dataset.kind;
      const all = catalog.items.filter(item => item.kind === kind);
      const cats = [...new Set(all.map(item => item.category))];
      const states = [...new Set(all.map(item => item.status))];
      mount.innerHTML = `<p class="catalog-notice">${escapeHTML(catalog.notice)}</p><div class="catalog-toolbar"><label>Поиск<input class="catalog-search" type="search" placeholder="${kind === 'equipment' ? 'Blackmagic, Amaran, объектив…' : kind === 'course' ? 'Камера, свет, монтаж…' : 'Видео, бот, подписка…'}" aria-label="Поиск: ${kindTitle[kind]}"></label><div class="filter-row"><label>Категория<select class="category-filter"><option value="">Все категории</option>${cats.map(cat => `<option value="${escapeHTML(cat)}">${escapeHTML(catalog.categories[cat] || cat)}</option>`).join('')}</select></label><label>Статус<select class="status-filter"><option value="">Все статусы</option>${states.map(state => `<option value="${state}">${statuses[state]}</option>`).join('')}</select></label></div><div class="catalog-results"><p class="result-count" role="status"></p><a href="#request">Моя заявка ↗</a></div></div><div class="catalog-grid"></div>`;
      mount.querySelector('.catalog-search').addEventListener('input', () => renderCatalog(mount));
      mount.querySelectorAll('select').forEach(select => select.addEventListener('change', () => renderCatalog(mount)));
      renderCatalog(mount);
    }
    renderSelection();
  } catch {
    document.querySelector('#catalog-stats').textContent = 'Каталог временно недоступен. Обнови страницу.';
    document.querySelectorAll('.catalog-mount').forEach(mount => { mount.textContent = 'Не удалось загрузить каталог. Можно оставить общую заявку.'; });
  }
}
document.addEventListener('click', event => {
  const add = event.target.closest('[data-add]');
  if (add && catalog && !busy) {
    if (selected.size >= 10) { announce('В одной заявке можно выбрать до 10 разных позиций. Убери лишнее в разделе «Заявка».'); return; }
    selected.set(add.dataset.add, 1); renderSelection(); refreshCatalogs();
    announce('Добавлено. Выбранные позиции — в разделе «Заявка».');
  }
  const remove = event.target.closest('[data-remove]');
  const quantity = event.target.closest('[data-quantity]');
  if (!busy && remove) { selected.delete(remove.dataset.remove); renderSelection(); refreshCatalogs(); }
  if (!busy && quantity) {
    const id = quantity.dataset.quantity;
    const item = catalog.items.find(row => row.id === id);
    const value = selected.get(id) + Number(quantity.dataset.delta);
    if (value <= 0) selected.delete(id); else selected.set(id, Math.min(value, maxQuantity(item)));
    renderSelection(); refreshCatalogs();
  }
  const reset = event.target.closest('[data-reset]');
  if (reset) { const mount = reset.closest('.catalog-mount'); mount.querySelectorAll('input,select').forEach(input => { input.value = ''; }); renderCatalog(mount); }
});
document.querySelector('#clear-selection').addEventListener('click', () => { if (!busy) { selected.clear(); renderSelection(); refreshCatalogs(); } });
window.addEventListener('hashchange', () => { document.querySelector('#catalog-feedback')?.remove(); });
route(); loadConfig(); loadCatalog();
