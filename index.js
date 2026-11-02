const { chromium } = require('playwright');

const MAIN_URL = 'https://miniblox.io/';
const CARD_DATA = process.env.CARD_DATA;
const SERVER_NAME = process.env.SERVER_NAME || 'bot';
const SESSION_COOKIE_VALUE = process.env.MB_SESSION;
const MAX_RUNTIME_MS = 320 * 60 * 1000;
const KEY_PRESS_INTERVAL_MS = 1000;
const CHECK_ALIVE_EVERY_MS = 30000;

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_RETRY_DELAYS_MS = [30000, 60000, 90000, 120000];

// Реконнект: больше попыток и нарастающие паузы, чтобы не злить miniblox
const RECONNECT_MAX_ATTEMPTS = 4;
const RECONNECT_RETRY_DELAYS_MS = [30000, 60000, 90000]; // 30с, 60с, 90с

if (!CARD_DATA) { console.error('❌ CARD_DATA не задан!'); process.exit(1); }
if (!SESSION_COOKIE_VALUE) { console.error('❌ MB_SESSION не задана!'); process.exit(1); }

const log = (...args) => console.log(`[${new Date().toISOString()}][${SERVER_NAME}]`, ...args);

// 🛡️ Глобальные ловушки — чтобы процесс не умирал молча
process.on('uncaughtException', (e) => {
  log(`💥 [uncaughtException] ${e.message}`);
  log(e.stack || '');
});
process.on('unhandledRejection', (e) => {
  log(`💥 [unhandledRejection] ${e && e.message ? e.message : String(e)}`);
});

function buildCardSelector(cardData) {
  const safe = cardData.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `div[role="button"]:has(span[data='${safe}'])`;
}
const CARD_SEL = buildCardSelector(CARD_DATA);

// Безопасное чтение URL — не кидает, если page закрыт
function safeUrl(page) {
  try { return page.url(); } catch { return '<closed>'; }
}
function isOnJoin(page) {
  const u = safeUrl(page);
  return typeof u === 'string' && /\/join\//.test(u);
}

async function tryCloseDialogs(page, ctx = '') {
  const sel = '[data-scope="dialog"][data-part="positioner"]';
  try {
    if (await page.locator(sel).count() === 0) return true;
    log(`⚠️ [${ctx}] закрываю диалоги`);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      if (await page.locator(sel).count() === 0) return true;
    }
  } catch {}
  return false;
}

async function waitForJoin(page, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (isOnJoin(page)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function loginToWorld(page) {
  log('🔁 Вход');
  try {
    await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    log(`❌ goto: ${e.message.slice(0, 100)}`);
    return false;
  }
  await page.waitForTimeout(4000);
  await tryCloseDialogs(page, 'load');

  try {
    await page.waitForSelector('button:has-text("Claim Reward")', { state: 'visible', timeout: 3000 });
    await page.click('button:has-text("Claim Reward")');
    log('✅ Claim Reward');
    await page.waitForTimeout(1500);
    await tryCloseDialogs(page, 'reward');
  } catch {}

  try {
    await page.waitForSelector('button:has-text("Planets")', { timeout: 20000 });
    await page.click('button:has-text("Planets")');
    await page.waitForTimeout(2000);
    await tryCloseDialogs(page, 'planets');
  } catch (e) {
    log(`❌ Planets: ${e.message.slice(0, 100)}`);
    return false;
  }

  try {
    await page.waitForSelector(CARD_SEL, { timeout: 20000 });
  } catch (e) {
    log(`❌ Карточка "${CARD_DATA}": ${e.message.slice(0, 100)}`);
    return false;
  }
  await page.waitForTimeout(500);
  await tryCloseDialogs(page, 'before-card');

  const card = page.locator(CARD_SEL).first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  try {
    await card.dblclick({ timeout: 8000 });
    log('✅ dblclick');
  } catch (e) {
    log(`⚠️ dblclick: ${e.message.slice(0, 80)}`);
    await tryCloseDialogs(page, 'retry');
    try {
      await card.dblclick({ force: true, timeout: 5000 });
    } catch (e2) {
      log(`❌ force dblclick: ${e2.message.slice(0, 80)}`);
      return false;
    }
  }

  const startWait = Date.now();
  let joined = false;
  let serverError = null;
  while (Date.now() - startWait < 15000) {
    if (isOnJoin(page)) { joined = true; break; }
    if (!serverError) {
      serverError = await page.evaluate(() => {
        const nodes = document.querySelectorAll('[role="alert"], .chakra-alert, .chakra-toast');
        for (const n of nodes) {
          if ((n.textContent || '').includes('Could not start')) return n.textContent.trim();
        }
        return null;
      });
    }
    await page.waitForTimeout(500);
  }

  if (!joined) {
    if (serverError) log(`❌ Сервер отклонил запуск: ${serverError.slice(0, 100)}`);
    log('⚠️ Load fallback');
    await tryCloseDialogs(page, 'load2');
    let btn = page.locator('[data-scope="dialog"] button:has-text("Load")').last();
    if (await btn.count() === 0) btn = page.locator('button:has-text("Load")').last();
    if (await btn.count() > 0) {
      try { await btn.click({ timeout: 5000 }); } catch {}
      joined = await waitForJoin(page, 30000);
    }
  }

  if (!joined) {
    log(`❌ не зашли. URL: ${safeUrl(page)}`);
    return false;
  }

  log(`✅ /join/: ${safeUrl(page)}`);
  await page.waitForTimeout(15000);
  let ok = false;
  try { ok = !!(await page.$('canvas')); } catch {}
  log(`🎮 canvas: ${ok ? '✅' : '⚠️'}`);
  return ok;
}

async function loginWithRetry(page, maxAttempts, delaysMs, label) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`🎯 [${label}] попытка ${attempt}/${maxAttempts}`);
    let ok = false;
    try {
      ok = await loginToWorld(page);
    } catch (e) {
      log(`❌ [${label}] loginToWorld упал: ${e.message.slice(0, 120)}`);
    }
    if (ok) {
      if (attempt > 1) log(`✅ [${label}] успех с попытки ${attempt}`);
      return true;
    }
    if (attempt < maxAttempts) {
      const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
      log(`😴 [${label}] неудача. Ждём ${delay / 1000}с и повторяем...`);
      try { await page.waitForTimeout(delay); } catch { return false; }
      try { await tryCloseDialogs(page, `${label}-retry`); } catch {}
    }
  }
  log(`❌ [${label}] все ${maxAttempts} попыток провалились`);
  return false;
}

// Создаёт новый context+page с той же cookie
async function createFreshPage(browser) {
  log('🆕 Создаю новый context+page (пересборка после падения)');
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: {
      cookies: [{
        name: 'mb_session',
        value: SESSION_COOKIE_VALUE,
        domain: '.miniblox.io',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
      }],
      origins: []
    }
  });
  const page = await context.newPage();

  page.on('framenavigated', f => {
    if (f === page.mainFrame()) log(`🔄 [NAV] ${safeUrl(page)}`);
  });
  page.on('pageerror', e => log(`❌ [PAGE] ${e.message.slice(0, 150)}`));
  page.on('console', m => {
    if (m.type() === 'error') log(`🖥️ [CONSOLE] ${m.text().slice(0, 150)}`);
  });
  page.on('websocket', ws => {
    log(`🔌 [WS OPEN]`);
    ws.on('close', () => log(`🔌 [WS CLOSE]`));
    ws.on('socketerror', e => log(`🔌 [WS ERR] ${String(e).slice(0, 100)}`));
  });
  page.on('crash', () => log('💥 [CRASH] страница упала!'));
  page.on('close', () => log('🚪 [CLOSE] страница закрыта'));

  return { context, page };
}

(async () => {
  const startTime = Date.now();
  log(`🚀 Старт (карточка: "${CARD_DATA}")`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let { context, page } = await createFreshPage(browser);

  let pageDead = false;
  const attachDeathHandlers = (p) => {
    p.on('crash', () => { pageDead = true; log('💥 page crash — помечен мёртвым'); });
    p.on('close', () => { pageDead = true; log('🚪 page closed — помечен мёртвым'); });
  };
  attachDeathHandlers(page);

  // Первый вход — с ретраями
  const firstOk = await loginWithRetry(page, LOGIN_MAX_ATTEMPTS, LOGIN_RETRY_DELAYS_MS, 'first-login');
  if (!firstOk) {
    log('💀 Не удалось войти после всех попыток — выхожу');
    try { await browser.close(); } catch {}
    process.exit(1);
  }

  try {
    const c = page.locator('canvas').first();
    const b = await c.boundingBox();
    if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    log('✅ фокус на канвас');
  } catch {}

  log('✅ В игре');
  let iter = 0;
  let recon = 0;
  let lastCheck = Date.now();
  let lastMemLog = Date.now();

  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    try {
      // === Проверка живости page ===
      if (pageDead) {
        log('🔧 page мёртв — пересобираю context+page');
        try { await context.close(); } catch {}
        try {
          const fresh = await createFreshPage(browser);
          context = fresh.context;
          page = fresh.page;
          pageDead = false;
          attachDeathHandlers(page);
        } catch (e) {
          log(`❌ Не удалось пересоздать page: ${e.message.slice(0, 120)}`);
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }
        const reOk = await loginWithRetry(page, RECONNECT_MAX_ATTEMPTS, RECONNECT_RETRY_DELAYS_MS, `rebuild-login`);
        if (reOk) log('✅ Пересборка успешна');
        else { log('❌ Пересборка не удалась, ждём 60с'); await new Promise(r => setTimeout(r, 60000)); }
        lastCheck = Date.now();
        continue;
      }

      // === Проверка URL ===
      if (Date.now() - lastCheck > CHECK_ALIVE_EVERY_MS) {
        lastCheck = Date.now();
        if (!isOnJoin(page)) {
          recon++;
          log(`🚨 [RECONNECT #${recon}] выкинуло. URL: ${safeUrl(page)}`);
          const reOk = await loginWithRetry(page, RECONNECT_MAX_ATTEMPTS, RECONNECT_RETRY_DELAYS_MS, `reconnect-${recon}`);
          if (reOk) {
            log(`✅ [RECONNECT #${recon}] вернулись`);
            try {
              const c = page.locator('canvas').first();
              const b = await c.boundingBox();
              if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
            } catch {}
          } else {
            log(`❌ [RECONNECT #${recon}] не удалось, ждём 60с`);
            await new Promise(r => setTimeout(r, 60000));
          }
          lastCheck = Date.now();
          continue;
        }
      }

      // === Периодический лог памяти (раз в 10 мин) ===
      if (Date.now() - lastMemLog > 10 * 60 * 1000) {
        lastMemLog = Date.now();
        const m = process.memoryUsage();
        log(`📊 mem: rss=${(m.rss / 1024 / 1024).toFixed(0)}MB, heap=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB`);
      }

      // === Движение ===
      try {
        await page.keyboard.down('KeyW'); await page.waitForTimeout(200); await page.keyboard.up('KeyW');
        await page.keyboard.down('KeyA'); await page.waitForTimeout(200); await page.keyboard.up('KeyA');
        await page.keyboard.down('KeyS'); await page.waitForTimeout(200); await page.keyboard.up('KeyS');
        await page.keyboard.down('KeyD'); await page.waitForTimeout(200); await page.keyboard.up('KeyD');
        await page.keyboard.press('Space');
      } catch (e) {
        log(`⚠️ нажатие: ${e.message.slice(0, 80)}`);
      }

      iter++;
      if (iter % 15 === 0) {
        try {
          const c = page.locator('canvas').first();
          const b = await c.boundingBox();
          if (b) {
            await page.mouse.move(
              b.x + b.width * (0.3 + Math.random() * 0.4),
              b.y + b.height * (0.3 + Math.random() * 0.4)
            );
          }
        } catch {}
      }

      await page.waitForTimeout(KEY_PRESS_INTERVAL_MS);

    } catch (e) {
      // 🛡️ Ловим всё, что могло вылететь из итерации — не даём умереть
      log(`💥 [LOOP ERROR] ${e.message.slice(0, 150)}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  log(`⏰ 5ч20м. Итераций: ${iter}, реконнектов: ${recon}`);
  try { await browser.close(); } catch {}
})().catch(e => {
  log(`💀 FATAL: ${e.message}`);
  process.exit(1);
});
