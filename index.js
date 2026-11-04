const { chromium } = require('playwright');
const fs = require('fs'); // нужен для сохранения debug-файлов

const MAIN_URL = 'https://miniblox.io/';
const BROWSE_MODE = process.env.BROWSE_MODE === '1';
const CARD_DATA = process.env.CARD_DATA;
const SERVER_NAME = process.env.SERVER_NAME || (BROWSE_MODE ? 'browse' : 'bot');
const SESSION_COOKIE_VALUE = process.env.MB_SESSION;

const MAX_RUNTIME_MS = 320 * 60 * 1000; // 5ч20м
const KEY_PRESS_INTERVAL_MS = 1000;
const CHECK_ALIVE_EVERY_MS = 30000;

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_RETRY_DELAYS_MS = [30000, 60000, 90000, 120000];
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_RETRY_DELAYS_MS = [15000, 30000];

// ===== Параллельный browse =====
const MAX_SERVERS = parseInt(process.env.MAX_SERVERS || '4', 10);
const LAUNCH_STAGGER_MS = parseInt(process.env.LAUNCH_STAGGER_SEC || '45', 10) * 1000;

// ❌ Серверы, которые НЕ трогаем по worldId (из URL картинки world-splash/<id>.jpg)
const SKIP_WORLD_IDS = [
  3092789, // 𝐓𝐇𝐄 𝐊𝐈𝐍𝐆 𝐒𝐌𝐏: 𝐄𝐕𝐎𝐋𝐕𝐄𝐃
  3080530, // DONT JOIN! I AM AFK! (skdke) — на всякий случай продублировали
];

// ❌ Плюс пропускаем по тексту (наши серверы DONT JOIN)
const SKIP_PATTERN = /dont\s*join/i;

if (!BROWSE_MODE && !CARD_DATA) { console.error('❌ CARD_DATA не задан!'); process.exit(1); }
if (!SESSION_COOKIE_VALUE) { console.error('❌ MB_SESSION не задана!'); process.exit(1); }

const log = (...args) => console.log(`[${new Date().toISOString()}][${SERVER_NAME}]`, ...args);

function buildCardSelector(data) {
  const safe = data.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `div[role="button"]:has(span[data='${safe}'])`;
}
const CARD_SEL = CARD_DATA ? buildCardSelector(CARD_DATA) : null;

async function tryCloseDialogs(page, ctx = '') {
  const sel = '[data-scope="dialog"][data-part="positioner"]';
  try {
    if (await page.locator(sel).count() === 0) return true;
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      if (await page.locator(sel).count() === 0) return true;
    }
  } catch {}
  return false;
}

async function openPlanets(page, slog) {
  try {
    await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    slog(`❌ goto: ${e.message.slice(0, 100)}`);
    return false;
  }
  await page.waitForTimeout(4000);
  await tryCloseDialogs(page, 'load');

  try {
    await page.waitForSelector('button:has-text("Claim Reward")', { state: 'visible', timeout: 3000 });
    await page.click('button:has-text("Claim Reward")');
    await page.waitForTimeout(1500);
    await tryCloseDialogs(page, 'reward');
  } catch {}

  try {
    await page.waitForSelector('button:has-text("Planets")', { timeout: 20000 });
    await page.click('button:has-text("Planets")');
    await page.waitForTimeout(2000);
    await tryCloseDialogs(page, 'planets');
  } catch (e) {
    slog(`❌ Planets: ${e.message.slice(0, 100)}`);
    return false;
  }
  return true;
}

async function joinSpecificServer(page, srvData, slog) {
  if (!(await openPlanets(page, slog))) return false;

  const sel = buildCardSelector(srvData);
  try {
    await page.waitForSelector(sel, { timeout: 20000 });
  } catch (e) {
    slog(`❌ карточка: ${e.message.slice(0, 80)}`);
    return false;
  }
  await page.waitForTimeout(300);
  await tryCloseDialogs(page, 'before-card');

  const card = page.locator(sel).first();
  try {
    await card.scrollIntoViewIfNeeded({ timeout: 5000 });
    await page.waitForTimeout(300);
    await card.dblclick({ timeout: 8000 });
  } catch {
    try { await card.dblclick({ force: true, timeout: 5000 }); } catch { return false; }
  }

  const wStart = Date.now();
  while (Date.now() - wStart < 30000) {
    if (/\/join\//.test(page.url())) {
      await page.waitForTimeout(10000);
      return !!(await page.$('canvas'));
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function joinWithRetry(page, srvData, slog, maxAttempts, delays) {
  for (let i = 1; i <= maxAttempts; i++) {
    slog(`🎯 попытка ${i}/${maxAttempts}`);
    let ok = false;
    try { ok = await joinSpecificServer(page, srvData, slog); } catch (e) {
      slog(`❌ ${e.message.slice(0, 100)}`);
    }
    if (ok) return true;
    if (i < maxAttempts) {
      const d = delays[Math.min(i - 1, delays.length - 1)];
      slog(`😴 ждём ${d / 1000}с`);
      await page.waitForTimeout(d);
    }
  }
  return false;
}

async function runOneServerBot(browser, srv, overallStartTime, delayBeforeStart) {
  const srvShort = srv.text.replace(/\s+/g, ' ').slice(0, 30);
  const slog = (...args) =>
    console.log(`[${new Date().toISOString()}][${SERVER_NAME}/${srvShort}]`, ...args);

  if (delayBeforeStart > 0) {
    slog(`⏳ ждём ${Math.round(delayBeforeStart / 1000)}с перед стартом`);
    await new Promise(r => setTimeout(r, delayBeforeStart));
  }

  slog(`🚀 старт бота`);
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: 1024, height: 700 },
      storageState: {
        cookies: [{
          name: 'mb_session', value: SESSION_COOKIE_VALUE,
          domain: '.miniblox.io', path: '/', httpOnly: true, secure: true, sameSite: 'Lax'
        }],
        origins: []
      }
    });

    const page = await context.newPage();
    page.on('pageerror', e => slog(`❌ [PAGE] ${e.message.slice(0, 100)}`));
    page.on('framenavigated', f => { if (f === page.mainFrame()) slog(`🔄 ${f.url()}`); });
    page.on('websocket', ws => {
      slog(`🔌 WS OPEN`);
      ws.on('close', () => slog(`🔌 WS CLOSE`));
    });

    const firstOk = await joinWithRetry(page, srv.data, slog, LOGIN_MAX_ATTEMPTS, LOGIN_RETRY_DELAYS_MS);
    if (!firstOk) {
      slog(`❌ первый вход провален — закрываю контекст`);
      await context.close();
      return;
    }
    slog(`✅ в игре`);

    try {
      const c = page.locator('canvas').first();
      const b = await c.boundingBox();
      if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    } catch {}

    let recon = 0;
    let lastCheck = Date.now();
    let lastMem = Date.now();

    while (Date.now() - overallStartTime < MAX_RUNTIME_MS) {
      if (Date.now() - lastCheck > CHECK_ALIVE_EVERY_MS) {
        lastCheck = Date.now();
        if (!/\/join\//.test(page.url())) {
          recon++;
          slog(`🚨 [RECONNECT #${recon}] выкинуло. URL: ${page.url()}`);
          const reOk = await joinWithRetry(
            page, srv.data, slog, RECONNECT_MAX_ATTEMPTS, RECONNECT_RETRY_DELAYS_MS
          );
          if (reOk) {
            slog(`✅ вернулись`);
            try {
              const c = page.locator('canvas').first();
              const b = await c.boundingBox();
              if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
            } catch {}
          } else {
            slog(`❌ реконнект провален, ждём 60с`);
            await page.waitForTimeout(60000);
          }
          lastCheck = Date.now();
          continue;
        }
      }

      if (Date.now() - lastMem > 10 * 60 * 1000) {
        lastMem = Date.now();
        const m = process.memoryUsage();
        slog(`📊 mem rss=${(m.rss / 1024 / 1024).toFixed(0)}MB heap=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB`);
      }

      try {
        await page.keyboard.down('KeyW'); await page.waitForTimeout(200); await page.keyboard.up('KeyW');
        await page.keyboard.down('KeyA'); await page.waitForTimeout(200); await page.keyboard.up('KeyA');
        await page.keyboard.down('KeyS'); await page.waitForTimeout(200); await page.keyboard.up('KeyS');
        await page.keyboard.down('KeyD'); await page.waitForTimeout(200); await page.keyboard.up('KeyD');
        await page.keyboard.press('Space');
      } catch {}

      if (Math.random() < 0.15) {
        try {
          const c = page.locator('canvas').first();
          const b = await c.boundingBox();
          if (b) await page.mouse.move(
            b.x + b.width * (0.3 + Math.random() * 0.4),
            b.y + b.height * (0.3 + Math.random() * 0.4)
          );
        } catch {}
      }

      await page.waitForTimeout(KEY_PRESS_INTERVAL_MS);
    }

    slog(`⏰ время вышло, реконнектов: ${recon}`);
  } catch (e) {
    slog(`💀 FATAL: ${e.message.slice(0, 150)}`);
  } finally {
    if (context) { try { await context.close(); } catch {} }
    slog(`🔒 контекст закрыт`);
  }
}

// Извлекает worldId из URL картинки карточки
async function extractWorldId(card) {
  try {
    const img = card.locator('img.chakra-image').first();
    if (await img.count() === 0) return null;
    const src = await img.getAttribute('src');
    if (!src) return null;
    const m = src.match(/world-splash\/(\d+)\./);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

async function browseAllServersParallel(browser, startTime) {
  const scoutCtx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: {
      cookies: [{
        name: 'mb_session', value: SESSION_COOKIE_VALUE,
        domain: '.miniblox.io', path: '/', httpOnly: true, secure: true, sameSite: 'Lax'
      }],
      origins: []
    }
  });
  const scoutPage = await scoutCtx.newPage();

  log('🔍 разведчик: собираю список серверов');
  if (!(await openPlanets(scoutPage, log))) {
    log('❌ разведчик не смог открыть Planets');
    await scoutCtx.close();
    return;
  }

  // 🆕 ЖДЁМ ЯВНОГО ПОЯВЛЕНИЯ КАРТОЧЕК (фикс "0 карточек")
  const cardSelector = 'div[role="button"]:has(span[data])';
  log(`⏳ жду загрузки карточек (${cardSelector})...`);

  try {
    await scoutPage.waitForSelector(cardSelector, { timeout: 15000 });
    log('✅ карточки появились');
  } catch (e) {
    log(`⚠️ карточки не появились за 15с, пробую Refresh...`);
    try {
      await scoutPage.click('button[aria-label="Refresh planet list"]', { timeout: 5000 });
      await scoutPage.waitForTimeout(3000);
      await scoutPage.waitForSelector(cardSelector, { timeout: 15000 });
      log('✅ карточки появились после Refresh');
    } catch (e2) {
      log(`❌ всё равно нет карточек: ${e2.message.slice(0, 80)}`);
      try {
        await scoutPage.screenshot({ path: 'debug-planets.png', fullPage: true });
        const html = await scoutPage.content();
        fs.writeFileSync('debug-planets.html', html);
        log('💾 сохранил debug-planets.png и debug-planets.html');
      } catch {}
    }
  }

  const cardsLoc = scoutPage.locator(cardSelector);
  const count = await cardsLoc.count();
  log(`📋 карточек на странице: ${count}`);

  const servers = [];
  const seen = new Set();

  for (let i = 0; i < count; i++) {
    const card = cardsLoc.nth(i);
    let data = '', text = '';
    try {
      const span = card.locator('span[data]').first();
      if (await span.count() === 0) continue;
      data = (await span.getAttribute('data')) || '';
      text = ((await span.textContent()) || '').trim();
    } catch { continue; }
    if (!text || !data) continue;

    // 1️⃣ Пропуск по worldId
    const worldId = await extractWorldId(card);
    if (worldId !== null && SKIP_WORLD_IDS.includes(worldId)) {
      log(`⏭️ пропуск по worldId ${worldId}: "${text.replace(/\s+/g, ' ').slice(0, 50)}"`);
      continue;
    }

    // 2️⃣ Пропуск по тексту (DONT JOIN)
    if (SKIP_PATTERN.test(data) || SKIP_PATTERN.test(text)) {
      log(`⏭️ пропуск по тексту: "${text.replace(/\s+/g, ' ').slice(0, 50)}"`);
      continue;
    }

    // 3️⃣ Дедуп по data
    if (seen.has(data)) continue;
    seen.add(data);

    servers.push({ text, data, worldId });
  }
  
  await scoutCtx.close();

  log(`📋 уникальных серверов (после фильтра): ${servers.length}`);
  servers.forEach((s, i) => log(`  [${i + 1}] worldId=${s.worldId || '?'} "${s.text.replace(/\s+/g, ' ').slice(0, 60)}"`));

  const limited = servers.slice(0, MAX_SERVERS);
  if (servers.length > MAX_SERVERS) {
    log(`⚠️ MAX_SERVERS=${MAX_SERVERS}, остальные ${servers.length - MAX_SERVERS} пропускаю`);
  }
  if (limited.length === 0) {
    log('⚠️ нечего запускать');
    return;
  }

  log(`🚀 запуск ${limited.length} параллельных ботов (stagger ${LAUNCH_STAGGER_MS / 1000}с)`);

  const tasks = limited.map((srv, idx) =>
    runOneServerBot(browser, srv, startTime, idx * LAUNCH_STAGGER_MS)
  );
  await Promise.all(tasks);
  log('✅ все параллельные боты завершены');
}

// ===== main =====
(async () => {
  const startTime = Date.now();
  log(BROWSE_MODE ? `🚀 Старт (browse parallel, MAX_SERVERS=${MAX_SERVERS})` : `🚀 Старт (карточка: "${CARD_DATA}")`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  if (BROWSE_MODE) {
    await browseAllServersParallel(browser, startTime);
    await browser.close();
    return;
  }

  // ===== ACCOUNT MODE (для bot.yml) =====
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: {
      cookies: [{
        name: 'mb_session', value: SESSION_COOKIE_VALUE,
        domain: '.miniblox.io', path: '/', httpOnly: true, secure: true, sameSite: 'Lax'
      }],
      origins: []
    }
  });
  const page = await context.newPage();
  page.on('framenavigated', f => { if (f === page.mainFrame()) log(`🔄 [NAV] ${f.url()}`); });
  page.on('pageerror', e => log(`❌ [PAGE] ${e.message.slice(0, 150)}`));
  page.on('console', m => { if (m.type() === 'error') log(`🖥️ [CONSOLE] ${m.text().slice(0, 150)}`); });

  const loginToWorld = async () => {
    if (!(await openPlanets(page, log))) return false;
    try { await page.waitForSelector(CARD_SEL, { timeout: 20000 }); } catch { return false; }
    await page.waitForTimeout(500);
    await tryCloseDialogs(page, 'before-card');
    const card = page.locator(CARD_SEL).first();
    try {
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await card.dblclick({ timeout: 8000 });
    } catch {
      try { await card.dblclick({ force: true, timeout: 5000 }); } catch { return false; }
    }
    const wStart = Date.now();
    while (Date.now() - wStart < 20000) {
      if (/\/join\//.test(page.url())) {
        await page.waitForTimeout(15000);
        return !!(await page.$('canvas'));
      }
      await page.waitForTimeout(500);
    }
    return false;
  };

  let firstOk = false;
  for (let i = 1; i <= LOGIN_MAX_ATTEMPTS; i++) {
    log(`🎯 [first-login] попытка ${i}/${LOGIN_MAX_ATTEMPTS}`);
    if (await loginToWorld()) { firstOk = true; break; }
    if (i < LOGIN_MAX_ATTEMPTS) {
      const d = LOGIN_RETRY_DELAYS_MS[Math.min(i - 1, LOGIN_RETRY_DELAYS_MS.length - 1)];
      log(`😴 ждём ${d / 1000}с`);
      await page.waitForTimeout(d);
    }
  }
  if (!firstOk) {
    log('💀 не удалось войти');
    await browser.close();
    process.exit(1);
  }
  log('✅ В игре');

  let iter = 0, recon = 0, lastCheck = Date.now();
  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    if (Date.now() - lastCheck > CHECK_ALIVE_EVERY_MS) {
      lastCheck = Date.now();
      if (!/\/join\//.test(page.url())) {
        recon++;
        log(`🚨 [RECONNECT #${recon}]`);
        let reOk = false;
        for (let i = 1; i <= RECONNECT_MAX_ATTEMPTS; i++) {
          if (await loginToWorld()) { reOk = true; break; }
          if (i < RECONNECT_MAX_ATTEMPTS) await page.waitForTimeout(
            RECONNECT_RETRY_DELAYS_MS[Math.min(i - 1, RECONNECT_RETRY_DELAYS_MS.length - 1)]
          );
        }
        if (!reOk) { log('❌ реконнект провален, 60с'); await page.waitForTimeout(60000); }
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
    } catch {}
    iter++;
    if (iter % 15 === 0) {
      try {
        const c = page.locator('canvas').first();
        const b = await c.boundingBox();
        if (b) await page.mouse.move(
          b.x + b.width * (0.3 + Math.random() * 0.4),
          b.y + b.height * (0.3 + Math.random() * 0.4)
        );
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
