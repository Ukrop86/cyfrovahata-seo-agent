# cyfrovahata-seo-agent

SEO агент для сайту `cyfrovahata.com.ua`, що збирає сторінки з `sitemap.xml`, аналізує SEO, генерує пропозиції через OpenAI, застосовує безпечні зміни у WordPress та відправляє звіти у Telegram.

## Швидкий старт

1. Створіть локальний `.env` на основі `.env.example`.
2. Встановіть залежності:

```bash
npm install
```

3. Побудуйте проект:

```bash
npm run build
```

4. Запустіть агента:

```bash
npm run start
```

## Скрипти

- `npm run build` — компілює TypeScript у `dist/`
- `npm run start` — запускає зібрану програму
- `npm run dev` — запускає у режимі розробки через `tsx`
- `npm run scan` — виконує сканування сайту та зберігає результати у SQLite
- `npm run apply` — застосовує pending SEO-пропозиції у WordPress
- `npm run proposals` — генерує та зберігає SEO-пропозиції, але не застосовує
- `npm run status` — показує короткий звіт стану бази та Telegram
- `npx tsx src/index.ts cleanup-archives` — шукає pending пропозиції для archive / taxonomy URL і позначає їх як invalid

## Налаштування `.env`

Обов’язкові змінні:

- `DB_PATH` — шлях до SQLite файлу, наприклад `./data/seo-agent.db`
- `OPENAI_API_KEY`
- `SCAN_LIMIT` — максимальна кількість сторінок для сканування
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WP_BASE_URL`
- `WP_USERNAME`
- `WP_APP_PASSWORD`
- `GOOGLE_CLIENT_EMAIL` і `GOOGLE_PRIVATE_KEY` — для Google Search Console (опціонально)

> Не коміть `.env` у репозиторій.

## Як працює Telegram

Агент надсилає повідомлення у Telegram чат після:

- сканування сторінок
- генерації SEO-пропозицій
- застосування пропозицій

Також бот підтримує команди:

- `/scan` — запустить нове сканування
- `/proposals` — покаже список активних пропозицій
- `/apply` — запустить застосування pending пропозицій
- `/status` — покаже стан бази та останню активність

## 401 у WordPress

Якщо WordPress повертає `401` або `rest_cannot_edit`, це може означати:

- неправильні `WP_USERNAME` / `WP_APP_PASSWORD`
- користувач не має права редагувати сторінки
- REST API вимкнено або адресу задано неправильно

У разі 401 агент не падає — він маркує пропозицію як `failed` і надсилає пояснення у Telegram.

## Перевірка прав WP користувача

1. Увійдіть у адмінку WordPress.
2. Перевірте, що користувач має роль `editor` або `administrator`.
3. Переконайтеся, що `Application Password` активний.
4. Перевірте, що URL `WP_BASE_URL` вказано правильно.
