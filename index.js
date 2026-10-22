const { chromium } = require('playwright');

const MAIN_URL = 'https://miniblox.io/';
const WORLD_ID = 3080530;
const SESSION_COOKIE_VALUE = process.env.MB_SESSION;
const MAX_RUNTIME_MS = 320 * 60 * 1000;
const KEY_PRESS_INTERVAL_MS = 1000;
const CHECK_ALIVE_EVERY_MS = 30000; // проверка «в игре ли мы» раз в 30 сек

if (!SESSION_COOKIE_VALUE) {
  console.error('❌ MB_SESSION не задана!');
  process.exit(1);
}

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

async function tryCloseDialogs(page, context = '') {
  const sel = '[data-scope="dialog"][data-part="positioner"]';
  const count = await page.locator(sel).count();
  if (count === 0) return true;
  log(`⚠️ [${context}] Диалогов: ${count}, закрываю...`);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    if (await page.locator(sel).count() === 0) {
      log(`✅ [${context}] Закрыт Escape`);
      return true;
    }
  }
  return (await page.locator(sel).count()) === 0;
}

async function waitForJoin(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (/\/join\//.test(page.url())) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// Полный цикл входа в игру через UI
async function loginToWorld(page) {
  log('🔁 Вход в мир (UI-цепочка)');

  try {
    await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    log(`❌ goto: ${e.message.slice(0, 100)}`);
    return false;
  }
  await page.waitForTimeout(4000);
  await tryCloseDialogs(page, 'after-load');

  // Награда
  try {
    await page.waitForSelector('button:has-text("Claim Reward")', { state: 'visible', timeout: 3000 });
    await page.click('button:has-text("Claim Reward")');
    log('✅ Claim Reward');
    await page.waitForTimeout(1500);
    await tryCloseDialogs(page, 'after-reward');
  } catch {}

  // Planets
  try {
    await page.waitForSelector('button:has-text("Planets")', { timeout: 20000 });
    await page.click('button:has-text("Planets")');
    await page.waitForTimeout(2000);
    await tryCloseDialogs(page, 'after-planets');
  } catch (e) {
    log(`❌ Planets: ${e.message.slice(0, 100)}`);
    return false;
  }

  // Карточка мира
  const cardSelector = `div[role="button"]:has(img[src*="${WORLD_ID}.jpg"])`;
  try {
    await page.waitForSelector(cardSelector, { timeout: 20000 });
  } catch (e) {
    log(`❌ Карточка: ${e.message.slice(0, 100)}`);
    return false;
  }
  await page.waitForTimeout(500);
  await tryCloseDialogs(page, 'before-card');

  const card = page.locator(cardSelector).first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  try {
    await card.dblclick({ timeout: 8000 });
    log('✅ Дабл-клик по карточке');
  } catch (e) {
    log(`⚠️ dblclick: ${e.message.slice(0, 80)}`);
    await tryCloseDialogs(page, 'retry-dblclick');
    try {
      await card.dblclick({ force: true, timeout: 5000 });
    } catch (e2) {
      log(`❌ force dblclick: ${e2.message.slice(0, 80)}`);
      return false;
    }
  }

  let joined = await waitForJoin(page, 15000);

  if (!joined) {
    log('⚠️ Нет редиректа, fallback — Load');
    await tryCloseDialogs(page, 'before-load');
    let loadBtn = page.locator('[data-scope="dialog"] button:has-text("Load")').last();
    if (await loadBtn.count() === 0) loadBtn = page.locator('button:has-text("Load")').last();
    if (await loadBtn.count() > 0) {
      try { await loadBtn.click({ timeout: 5000 }); } catch {}
      joined = await waitForJoin(page, 30000);
    }
  }

  if (!joined) {
    log(`❌ Не удалось зайти. URL: ${page.url()}`);
    return false;
  }

  log(`✅ На /join/: ${page.url()}`);
  await page.waitForTimeout(15000);

  const hasCanvas = !!(await page.$('canvas'));
  log(`🎮 Canvas: ${hasCanvas ? '✅' : '⚠️'}`);
  return hasCanvas;
}

(async () => {
  const startTime = Date.now();
  log('🚀 Старт v5 (авто-реконнект)');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

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

  // Логи диагностики
  page.on('framenavigated', f => {
    if (f === page.mainFrame()) log(`🔄 [NAV] ${f.url()}`);
  });
  page.on('pageerror', err => log(`❌ [PAGE ERROR] ${err.message.slice(0, 200)}`));
  page.on('console', m => {
    if (m.type() === 'error') log(`🖥️  [CONSOLE ERR] ${m.text().slice(0, 200)}`);
  });
  page.on('websocket', ws => {
    log(`🔌 [WS OPEN] ${ws.url().slice(0, 100)}`);
    ws.on('close', () => log(`🔌 [WS CLOSE] ${ws.url().slice(0, 100)}`));
    ws.on('socketerror', err => log(`🔌 [WS ERR] ${String(err).slice(0, 100)}`));
  });

  // Первый вход
  const ok = await loginToWorld(page);
  if (!ok) {
    log('❌ Первый вход не удался, выхожу');
    await browser.close();
    process.exit(1);
  }

  // Клик по канвасу — фокус
  try {
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    log('✅ Клик по канвасу (фокус)');
  } catch {}

  log('✅ Бот в игре. Цикл нажатий с авто-реконнектом...');

  let iteration = 0;
  let reconnectCount = 0;
  let lastAliveCheck = Date.now();

  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    // ===== Проверка «в игре ли мы» =====
    if (Date.now() - lastAliveCheck > CHECK_ALIVE_EVERY_MS) {
      lastAliveCheck = Date.now();
      const url = page.url();
      if (!/\/join\//.test(url)) {
        reconnectCount++;
        log(`🚨 [RECONNECT #${reconnectCount}] Выкинуло! URL: ${url}`);
        const recOk = await loginToWorld(page);
        if (recOk) {
          log(`✅ [RECONNECT #${reconnectCount}] Вернулись в игру`);
          try {
            const canvas = page.locator('canvas').first();
            const box = await canvas.boundingBox();
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          } catch {}
        } else {
          log(`❌ [RECONNECT #${reconnectCount}] Не удалось. Ждём 30 сек`);
          await page.waitForTimeout(30000);
        }
        lastAliveCheck = Date.now();
        continue;
      }
    }

    // ===== Движения WASD + Space =====
    try {
      await page.keyboard.down('KeyW'); await page.waitForTimeout(200); await page.keyboard.up('KeyW');
      await page.keyboard.down('KeyA'); await page.waitForTimeout(200); await page.keyboard.up('KeyA');
      await page.keyboard.down('KeyS'); await page.waitForTimeout(200); await page.keyboard.up('KeyS');
      await page.keyboard.down('KeyD'); await page.waitForTimeout(200); await page.keyboard.up('KeyD');
      await page.keyboard.press('Space');
    } catch (e) {
      log(`⚠️ нажатие: ${e.message.slice(0, 80)}`);
    }

    // ===== Раз в 15 итераций — движение мыши (анти-AFK) =====
    iteration++;
    if (iteration % 15 === 0) {
      try {
        const canvas = page.locator('canvas').first();
        const box = await canvas.boundingBox();
        if (box) {
          const x = box.x + box.width * (0.3 + Math.random() * 0.4);
          const y = box.y + box.height * (0.3 + Math.random() * 0.4);
          await page.mouse.move(x, y);
        }
      } catch {}
    }

    await page.waitForTimeout(KEY_PRESS_INTERVAL_MS);
  }

  log(`⏰ 5ч20м. Итераций: ${iteration}, реконнектов: ${reconnectCount}`);
  await browser.close();
})().catch(err => {
  log(`💀 FATAL: ${err.message}`);
  process.exit(1);
});
