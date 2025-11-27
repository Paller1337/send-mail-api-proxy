Mail API Proxy — SMTP‑прокси для Timeweb

Статичный HTTP‑сервис для отправки писем через SMTP (Timeweb и др.). Один эндпоинт: `POST /send-mail`. Пароли нигде не сохраняются: получил запрос → отправил через указанный SMTP.

# Возможности
- Отправка писем через SMTP (SSL/TLS 465 или STARTTLS 25/2525)
- Управление режимами SMTP‑подключения (`SMTP_ALLOWED_MODES`)
- Идемпотентные отправки (`Idempotency-Key` / `message.customId`)
- Безопасность: Basic Auth, CORS, IP‑allowlist, rate limit
- Метрики и служебные эндпоинты: `GET /health`, `GET /config`, `GET /smtp-modes`, `GET /metrics`
- Структурированные логи в JSON (pino)
- Поддержка DKIM (передача приватного ключа в теле запроса)

# Быстрый старт на VPS (Debian/Ubuntu)
Установка через скрипт:
```bash
REPO_URL=https://github.com/Paller1337/send-mail-api-proxy.git \
BRANCH=main \
HTTP_PORT=8080 \
bash -c "$(wget -qO- https://raw.githubusercontent.com/Paller1337/send-mail-api-proxy/main/scripts/install_server.sh)"
```

Скрипт установит Docker + Compose, клонирует репозиторий в `/opt/mail-api-proxy`, создаст `.env` и запустит `docker compose up -d --build`.

### Пример продвинутой установки (кастомный форк)
```bash
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

Дальше все настройки можно править в `/opt/mail-api-proxy/.env` и перезапускать через `docker compose up -d`.

# Локальный запуск (Docker Compose)
```bash
cp .env.example .env
./scripts/compose-up.sh
curl http://localhost:8080/health
```

Остановка:
```bash
./scripts/compose-down.sh
```

# Основные переменные окружения (.env)
- `PORT=8080` — порт, на котором слушает Node‑приложение
- `HTTP_PORT=8080` — пробрасываемый наружу HTTP‑порт (для Docker‑установки)
- `TRUST_PROXY=1` — доверять заголовкам прокси (`X-Forwarded-For` и т.п.)
- `REQUEST_BODY_LIMIT=2mb` — лимит размера тела запроса
- `CORS_ORIGINS=` — список разрешённых Origin через запятую; пусто — разрешено всё
- `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` — включить Basic Auth, если заданы
- `IP_ALLOWLIST=` — список IP/CIDR, которым разрешён доступ; пусто — без ограничений по IP
- `RATE_LIMIT_WINDOW_MS=60000`, `RATE_LIMIT_MAX=30` — лимит запросов в окне (по IP)
- `IDEMPOTENCY_TTL_SECONDS=600` — TTL для кеша идемпотентных ответов
- `ENABLE_METRICS=false` — включить `/metrics` (Prometheus)
- `LOG_LEVEL=info` — уровень логирования pino
- `SMTP_ALLOWED_MODES=` — список разрешённых режимов SMTP, например: `465-tls,2525-starttls` (пусто — разрешить все)
- Таймауты SMTP (опционально):
  - `SMTP_CONNECTION_TIMEOUT_MS=15000`
  - `SMTP_GREETING_TIMEOUT_MS=15000`
  - `SMTP_SOCKET_TIMEOUT_MS=30000`
  - `MAIL_SEND_TIMEOUT_MS=45000`

# Рекомендуемая базовая конфигурация
- Приложение: `PORT=8080` (внутренний порт), наружу пробрасывать `HTTP_PORT`
- Прокси: `TRUST_PROXY=1` за прокси/Ingress
- Лимит тела: `REQUEST_BODY_LIMIT=2mb`
- CORS: указать боевые домены в `CORS_ORIGINS`
- Basic Auth: включить через `BASIC_AUTH_USER/PASS` при необходимости
- IP‑allowlist: ограничить доступ по IP/CIDR через `IP_ALLOWLIST`
- Rate limit: оставить значения `60000/30` или усилить
- Идемпотентность: настроить `IDEMPOTENCY_TTL_SECONDS` под свою нагрузку
- Метрики: включить `ENABLE_METRICS=true`, если собираете Prometheus
- SMTP‑режимы: ограничить `SMTP_ALLOWED_MODES`, чтобы не допустить неожиданных портов/режимов

# API
- `GET /health` — статус сервиса + список разрешённых SMTP‑режимов
- `GET /config` — публичные настройки (без секретов)
- `GET /smtp-modes?host=smtp.timeweb.ru[&modes=465-tls,2525-starttls]` — проверка доступности указанных режимов
- `GET /metrics` — метрики Prometheus (если включено)
- `POST /send-mail` — отправка письма

## Минимальный пример запроса (TLS 465)
```http
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
    "subject": "Тестовое письмо",
    "text": "Hello"
  }
}
```

STARTTLS (вместо 465):
```json
"port": 2525,
"secure": false
```

## Дополнительные поля запроса `/send-mail`

Минимальный запрос выше остаётся валидным и не меняется. Ниже — все возможные поля.

### Объект `smtp`
- `host` (string) — SMTP‑хост (по умолчанию `smtp.timeweb.ru`)
- `port` (number) — порт, например 465 (SSL/TLS), 25/2525 (STARTTLS)
- `secure` (boolean) — `true` для SSL/TLS, `false` для STARTTLS
- `username` (string) — логин SMTP (например `no-reply@yourdomain.ru`)
- `password` (string) — пароль SMTP
- `dkimPrivateKey` (string, optional) — приватный DKIM‑ключ (PEM), если передан — включается DKIM‑подпись
- `dkimKeySelector` (string, optional) — DKIM selector; если не указан, используется `default`
- `dkimDomain` (string, optional) — домен для DKIM; если не указан, берётся из `message.from`

### Объект `message`
- `from` (string) — отправитель, например `no-reply@yourdomain.ru` или `"Name <no-reply@yourdomain.ru>"`
- `to` (string[]) — список получателей (обязателен, не пустой)
- `cc` (string[], optional) — список адресов в копии (CC)
- `bcc` (string[], optional) — список скрытых адресов (BCC)
- `subject` (string) — тема письма
- `text` (string, optional) — текстовая версия письма
- `html` (string, optional) — HTML‑версия письма  
  Должен быть указан хотя бы `text` или `html` (или оба).
- `replyTo` (string, optional) — адрес в поле Reply‑To
- `attachments` (array, optional) — вложения:
  - `filename` (string) — имя файла
  - `contentBase64` (string) — содержимое файла в Base64
  - `contentType` (string, optional) — MIME‑тип (например, `application/pdf`)
- `headers` (object, optional) — произвольные заголовки письма
- `customId` (string, optional) — ваш ID сообщения для идемпотентности (альтернатива заголовку `Idempotency-Key`)

## Идемпотентность
- Можно передать `Idempotency-Key: <uuid>` в заголовке или `message.customId` в теле.
- Повторные запросы с тем же ключом в течение `IDEMPOTENCY_TTL_SECONDS` возвращают тот же результат без повторной отправки письма.

## Ответы
- `200` — `{ "id": "<messageId>", "accepted": [...], "rejected": [...] }`
- `400` — ошибка валидации JSON
- `401` — Basic Auth или IP‑ограничение
- `422` — ошибка SMTP (невалидный адрес, аутентификация и т.п.)
- `429` — превышен rate limit
- `504` — таймаут/ошибка подключения к SMTP
- `500` — внутренняя ошибка сервера

## SMTP‑режимы и диагностика
- На некоторых VPS/сетях могут быть закрыты порты 25/465. Часто открыт 2525 (STARTTLS).
- Проверить доступность режимов можно через:
  ```bash
  curl "http://localhost:8080/smtp-modes?host=smtp.timeweb.ru"
  ```
- Ограничить разрешённые режимы можно через `SMTP_ALLOWED_MODES`, например:
  ```env
  SMTP_ALLOWED_MODES=2525-starttls
  ```
  В этом случае попытка отправить письмо через 465‑TLS вернёт `422` c `error: "Mode not allowed"`.

## Примеры curl

### TLS 465 с идемпотентностью
```bash
curl -X POST http://localhost:8080/send-mail \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7d9ad0d5-6f6e-48e5-8c6f-6f1d7c7b3f21" \
  -d '{
    "smtp": {
      "host":"smtp.timeweb.ru",
      "port":465,
      "secure":true,
      "username":"no-reply@yourdomain.ru",
      "password":"MAILBOX_PASSWORD"
    },
    "message": {
      "from":"no-reply@yourdomain.ru",
      "to":["recipient@example.com"],
      "subject":"Тестовое письмо",
      "text":"Hello"
    }
  }'
```

### STARTTLS 2525
```bash
curl -X POST http://localhost:8080/send-mail \
  -H "Content-Type: application/json" \
  -d '{
    "smtp": {
      "host":"smtp.timeweb.ru",
      "port":2525,
      "secure":false,
      "username":"no-reply@yourdomain.ru",
      "password":"MAILBOX_PASSWORD"
    },
    "message": {
      "from":"no-reply@yourdomain.ru",
      "to":["recipient@example.com"],
      "subject":"Тестовое письмо",
      "text":"Hello"
    }
  }'
```

### С Basic Auth (если включен)
```bash
curl -u api:strong-pass -X POST http://localhost:8080/send-mail \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

## DKIM‑подпись
- Для включения DKIM достаточно передать в объекте `smtp`:
  - `dkimPrivateKey` — приватный ключ в PEM‑формате
  - `dkimKeySelector` — selector (например `default`, если в DNS TXT‑запись `default._domainkey.example.com`)
  - `dkimDomain` — домен для подписи (`example.com`); если не задан, берётся из `message.from`.
- Если эти поля не передавать, поведение полностью совпадает с прежней версией — никаких изменений в минимальном запросе.
