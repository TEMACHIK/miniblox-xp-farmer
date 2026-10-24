const { chromium } = require('playwright');

const MAIN_URL = 'https://miniblox.io/';
const CARD_DATA = process.env.CARD_DATA;
const SERVER_NAME = process.env.SERVER_NAME || 'bot';
const SESSION_COOKIE_VALUE = process.env.MB_SESSION;
const MAX_RUNTIME_MS = 320 * 60 * 1000;
const KEY_PRESS_INTERVAL_MS = 1000;
const CHECK_ALIVE_EVERY_MS = 30000;

if (!CARD_DATA) { console.error('❌ CARD_DATA не задан!'); process.exit(1); }
if (!SESSION_COOKIE_VALUE) { console.error('❌ MB_SESSION не задана!'); process.exit(1); }

const log = (...args) => console.log(`[${new Date().toISOString()}][${SERVER_NAME}]`, ...args);

// Селектор карточки по атрибуту data у span внутри неё
function buildCardSelector(cardData) {
  // Экранируем одинарные кавычки, если вдруг появятся в названии
  const safe = cardData.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `div[role="button"]:has(span[data='${safe}'])`;
}

const CARD_SEL = buildCardSelector(CARD_DATA);

async function tryCloseDialogs(page, ctx = '') {
  const sel = '[data-scope="dialog"][data-part="positioner"]';
  if (await page.locator(sel).count() === 0) return true;
  log(`⚠️ [${ctx}] закрываю диалоги`);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    if (await page.locator(sel).count() === 0) return true;
  }
  return (await page.locator(sel).count()) === 0;
}

async function waitForJoin(page, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (/\/join\//.test(page.url())) return true;
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

  let joined = await waitForJoin(page, 15000);
  if (!joined) {
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
    log(`❌ не зашли. URL: ${page.url()}`);
    return false;
  }

  log(`✅ /join/: ${page.url()}`);
  await page.waitForTimeout(15000);
  const ok = !!(await page.$('canvas'));
  log(`🎮 canvas: ${ok ? '✅' : '⚠️'}`);
  return ok;
}

(async () => {
  const startTime = Date.now();
  log(`🚀 Старт (карточка: "${CARD_DATA}")`);

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

  page.on('framenavigated', f => {
    if (f === page.mainFrame()) log(`🔄 [NAV] ${f.url()}`);
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

  if (!(await loginToWorld(page))) {
    log('❌ Первый вход не удался');
    await browser.close();
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

  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    if (Date.now() - lastCheck > CHECK_ALIVE_EVERY_MS) {
      lastCheck = Date.now();
      if (!/\/join\//.test(page.url())) {
        recon++;
        log(`🚨 [RECONNECT #${recon}] выкинуло. URL: ${page.url()}`);
        if (await loginToWorld(page)) {
          log(`✅ [RECONNECT #${recon}] вернулись`);
          try {
            const c = page.locator('canvas').first();
            const b = await c.boundingBox();
            if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
          } catch {}
        } else {
          log(`❌ [RECONNECT #${recon}] не удалось, ждём 30с`);
          await page.waitForTimeout(30000);
        }
        lastCheck = Date.now();
        continue;
      }
    }

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
  }

  log(`⏰ 5ч20м. Итераций: ${iter}, реконнектов: ${recon}`);
  await browser.close();
})().catch(e => {
  log(`💀 FATAL: ${e.message}`);
  process.exit(1);
});
