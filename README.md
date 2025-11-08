Mail API Proxy — SMTP‑прокси для Timeweb

Статичный HTTP‑сервис для отправки писем через SMTP (Timeweb и др.). Один эндпоинт: `POST /send-mail`. Пароли нигде не сохраняются: получил запрос → отправил через указанный SMTP.

# Возможности
- Отправка писем через SSL/TLS 465 и STARTTLS 25/2525
- Валидация входных данных
- Идемпотентность по `Idempotency-Key`/`message.customId`
- Безопасность: Basic Auth (опц.), CORS, IP‑allowlist, rate limit
- Наблюдаемость: `GET /health`, `GET /config`, `GET /smtp-modes`, `GET /metrics` (опц.)
- Логи JSON (pino), Docker/Compose

# Установка на VPS одной командой
Выполните на сервере (Debian/Ubuntu)
```
REPO_URL=https://raw.githubusercontent.com/Paller1337/send-mail-api-proxy.git \
BRANCH=main \
HTTP_PORT=8080 \
bash -c "$(wget -qO- https://raw.githubusercontent.com/Paller1337/send-mail-api-proxy/main/scripts/install_server.sh)"
```
Скрипт установит Docker + Compose, клонирует проект в `/opt/mail-api-proxy`, создаст `.env` (если нет) и запустит `docker compose up -d --build`.

### Кастомные параметры (пример)
```
REPO_URL=https://github.com/<user>/<repo>.git \
BRANCH=main \
HTTP_PORT=8080 \
BASIC_AUTH_USER=api BASIC_AUTH_PASS=strong-pass \
CORS_ORIGINS=https://app.example,https://admin.example \
IP_ALLOWLIST=203.0.113.10,10.0.0.0/8 \
SMTP_ALLOWED_MODES=2525-starttls \
ENABLE_METRICS=true LOG_LEVEL=info \
RATE_LIMIT_WINDOW_MS=60000 RATE_LIMIT_MAX=30 \
SMTP_CONNECTION_TIMEOUT_MS=8000 SMTP_SOCKET_TIMEOUT_MS=15000 MAIL_SEND_TIMEOUT_MS=20000 \
bash -c "$(wget -qO- https://raw.githubusercontent.com/<user>/<repo>/main/scripts/install_server.sh)"
```
Все указанные переменные скрипт пропишет/обновит в `/opt/mail-api-proxy/.env` перед запуском.

# Быстрый старт локально (Docker Compose)
```
cp .env.example .env
./scripts/compose-up.sh
curl http://localhost:8080/health
```
Остановка: `./scripts/compose-down.sh`

# Переменные окружения (.env)
- `PORT=8080` — порт в контейнере
- `HTTP_PORT=8080` — публикуемый порт хоста
- `TRUST_PROXY=1` — доверять первому прокси
- `REQUEST_BODY_LIMIT=2mb` — лимит тела запроса
- `CORS_ORIGINS=` — список доменов; пусто = разрешить всем
- `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` — Basic Auth (опц.)
- `IP_ALLOWLIST=` — список IP/CIDR; пусто = разрешить всем
- `RATE_LIMIT_WINDOW_MS=60000`, `RATE_LIMIT_MAX=30` — троттлинг
- `IDEMPOTENCY_TTL_SECONDS=600` — TTL кэша ответов
- `ENABLE_METRICS=false` — включить `/metrics`
- `LOG_LEVEL=info` — уровень логов
- `SMTP_ALLOWED_MODES=` — политика SMTP‑режимов, напр.: `465-tls,2525-starttls` (пусто = все)
- Таймауты SMTP (опц.):
  - `SMTP_CONNECTION_TIMEOUT_MS=15000`
  - `SMTP_GREETING_TIMEOUT_MS=15000`
  - `SMTP_SOCKET_TIMEOUT_MS=30000`
  - `MAIL_SEND_TIMEOUT_MS=45000`

# Дефолтные настройки
- Порт сервиса: `PORT=8080` (в контейнере), публикация: `HTTP_PORT=8080`
- Trust proxy: `TRUST_PROXY=1`
- Лимит тела: `REQUEST_BODY_LIMIT=2mb`
- CORS: по умолчанию разрешены все источники (`CORS_ORIGINS` пустой)
- Basic Auth: выключен (не задан `BASIC_AUTH_USER/PASS`)
- IP‑allowlist: выключен (пустой `IP_ALLOWLIST`)
- Rate limit: `RATE_LIMIT_WINDOW_MS=60000`, `RATE_LIMIT_MAX=30`
- Идемпотентность TTL: `IDEMPOTENCY_TTL_SECONDS=600`
- Метрики: выключены (`ENABLE_METRICS=false`)
- Логи: `LOG_LEVEL=info`
- SMTP режимы: не ограничены (`SMTP_ALLOWED_MODES` пустой)
- Таймауты SMTP: `15000/15000/30000`, отправка `45000` мс

# API
- `GET /health` — статус + разрешённые SMTP‑режимы
- `GET /config` — текущая конфигурация (без секретов)
- `GET /smtp-modes?host=smtp.timeweb.ru[&modes=465-tls,2525-starttls]` — проверка доступности режимов
- `GET /metrics` — метрики Prometheus (если включено)
- `POST /send-mail` — отправка письма

### Минимальный запрос (TLS 465)
```
POST /send-mail
Content-Type: application/json

{
  "smtp": {
    "host": "smtp.timeweb.ru",
    "port": 465,
    "secure": true,
    "username": "no-reply@yourdomain.ru",
    "password": "MAILBOX_PASSWORD"
  },
  "message": {
    "from": "no-reply@yourdomain.ru",
    "to": ["recipient@example.com"],
    "subject": "Тест",
    "text": "Hello"
  }
}
```

STARTTLS (если 465 недоступен)
```
"port": 2525,
"secure": false
```

### Идемпотентность
- Добавьте заголовок `Idempotency-Key: <ключ>` или поле `message.customId`. Повторные запросы с тем же ключом вернут первый ответ в течение `IDEMPOTENCY_TTL_SECONDS`.

### Коды ответов
- `200` — `{ id, accepted, rejected }`
- `400` — ошибка валидации
- `401` — Basic Auth/IP‑allowlist
- `422` — ошибка SMTP (аутентификация/контент)
- `429` — троттлинг
- `504` — таймаут/недоступность SMTP
- `500` — иная ошибка

### SMTP‑режимы и диагностика
- На некоторых VPS/ISP исходящие 25/465 заблокированы; 2525 чаще открыт.
- Проверяйте доступность: `GET /smtp-modes`.
- Ограничивайте режимы политикой: `SMTP_ALLOWED_MODES=2525-starttls` или, например, `465-tls,2525-starttls`.

### Обновление
```
docker compose up -d --build
```

### Логи
```
docker compose logs -f
```
