const puppeteer = require('puppeteer');
const http = require('http');

// Простой веб-сервер, чтобы Render понимал, что приложение «живое»
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Miniblox Bot is running 24/7!\n');
}).listen(PORT, () => {
    console.log(`Web server is listening on port ${PORT}`);
});

async function startBot() {
    try {
        console.log('Запуск браузера...');
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        // Установка куки сессии
        const sessionCookie = {
            name: 'mb_session',
            value: '50fe26782a0a05e311c69dd626207b1d', // <-- Вставь свой токен сюда
            domain: '.miniblox.io',
            path: '/',
            httpOnly: true,
            secure: true
        };

        await page.setCookie(sessionCookie);
        console.log('Кука успешно установлена.');

        // Заходим на главный сайт для применения куки
        await page.goto('https://miniblox.io/', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 3000));

        // Переходим в нужную комнату
        const targetUrl = 'https://miniblox.io/join/LMITQN'; // <-- Твоя ссылка
        console.log(`Переходим в комнату: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        console.log('Бот зашел в игру и начал симуляцию движения...');
        const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];

        // Цикл движения 24/7
        while (true) {
            try {
                for (const key of keys) {
                    await page.mouse.click(640, 360);
                    await page.keyboard.down(key);
                    await new Promise(r => setTimeout(r, 1500));
                    await page.keyboard.up(key);
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch (loopError) {
                console.error('Ошибка в игровом цикле:', loopError);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    } catch (error) {
        console.error('Критическая ошибка браузера, перезапуск через 10 секунд...', error);
        setTimeout(startBot, 10000);
    }
}

startBot();
