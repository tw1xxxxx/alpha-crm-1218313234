# CRM Task Tracker

CRM для проектов, лидов, сотрудников и заказов «В работе».  
Работает как **Electron desktop** и как **веб-приложение на Vercel** с **Postgres** для надёжного хранения данных.

## Быстрый старт (локально)

```bash
npm install
npm run dev              # только фронт (localStorage)
npm run electron:dev     # десктоп + electron-store
npm run vercel:dev       # фронт + API + Postgres (нужен .env.local)
```

## Деплой на Vercel

### 1. GitHub

```bash
git init
git add .
git commit -m "Prepare CRM for Vercel hosting"
git branch -M main
git remote add origin https://github.com/ВАШ_АККАУНТ/tasklist.git
git push -u origin main
```

### 2. Vercel

1. [vercel.com](https://vercel.com) → **Add New Project** → импорт репозитория с GitHub.
2. Framework: **Vite** (определится автоматически).
3. **Storage** → **Create Database** → **Postgres** (Neon). Подключите к проекту — появится `POSTGRES_URL`.
4. **Settings → Environment Variables** (Production + Preview + Development):

| Переменная | Значение |
|------------|----------|
| `CRM_SYNC_SECRET` | длинная случайная строка (сервер) |
| `VITE_CRM_SYNC_SECRET` | **то же значение** (клиент, для API) |

5. **Deploy**. После деплоя проверьте: `https://ваш-проект.vercel.app/api/health`  
   Должно быть `{ "ok": true, "postgres": true }`.

### 3. Как хранятся данные

- Таблица `crm_store`: ключ → JSON-массив (проекты, лиды, задачи и т.д.).
- Клиент пишет в **localStorage** (кэш) и синхронизирует с **Postgres** через `/api/store/*`.
- При закрытии вкладки — **bulk-сохранение** с `keepalive`.
- Electron по-прежнему использует **electron-store** + облако, если задан `VITE_CRM_SYNC_SECRET`.

### 4. Лимиты Hobby

На бесплатном тарифе Vercel достаточно для личной CRM. Postgres Neon free tier даёт отдельные лимиты — для одного пользователя этого обычно хватает.

## Безопасность

`VITE_CRM_SYNC_SECRET` виден в браузере — это защита от случайных запросов, не полноценная авторизация. Задайте длинный секрет и не публикуйте его.

## Скрипты

| Команда | Описание |
|---------|----------|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run vercel:dev` | Локально как на Vercel (API + DB) |
| `npm run electron:dev` | Десктоп-приложение |
