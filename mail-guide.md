Mail API Proxy — шпаргалка для бэкендера

База
- URL: `POST /send-mail`
- Headers: `Content-Type: application/json` (+ опц. `Idempotency-Key: <uuid>`)
- Auth: если включён Basic Auth — отправляйте `Authorization: Basic ...` (или `-u user:pass` в curl)

Схема тела (минимум)
```
{
  "smtp": {
    "host": "smtp.timeweb.ru",
    "port": 465,            // 465 = SSL/TLS, 25/2525 = STARTTLS
    "secure": true,         // true = SSL/TLS, false = STARTTLS
    "username": "no-reply@yourdomain.ru",
    "password": "MAILBOX_PASSWORD"
  },
  "message": {
    "from": "no-reply@yourdomain.ru",
    "to": ["recipient@example.com"],
    "subject": "Тест",
    "text": "Hello"        // или html (одно из двух обязательно)
  }
}
```

STARTTLS (если 465 недоступен)
```
"port": 2525,
"secure": false
```

Вложения (base64)
```
"attachments": [
  { "filename": "doc.pdf", "contentBase64": "<BASE64>", "contentType": "application/pdf" }
]
```
Совет: следите за лимитом тела запроса (`REQUEST_BODY_LIMIT`), по умолчанию 2–1 МБ в конфиге.

Идемпотентность
- Рекомендуется для безопасных ретраев: заголовок `Idempotency-Key` ИЛИ `message.customId`.
- Повтор запроса с тем же ключом вернёт первый ответ в течение `IDEMPOTENCY_TTL_SECONDS`.

Ответы
- 200: `{ "id": "<messageId>", "accepted": [...], "rejected": [...] }`
- 400: ошибка валидации JSON
- 401: Basic Auth не пройдена или IP не в allowlist
- 422: ошибка SMTP (аутентификация/контент)
- 429: превышен лимит запросов (по IP)
- 504: таймаут/недоступность SMTP
- 500: иная ошибка

Диагностика и режимы
- `GET /health` — статус + разрешённые SMTP‑режимы
- `GET /config` — текущая конфигурация (без секретов)
- `GET /smtp-modes?host=smtp.timeweb.ru` — проверка доступности 465/2525/25 из окружения
- Политика режимов (`SMTP_ALLOWED_MODES`): например, `465-tls,2525-starttls` или только `2525-starttls`. Если запросит запрещённый режим — 422.

Примеры ответов

GET /health
```
curl http://localhost:8080/health

{
  "status": "ok",
  "uptime": 123.456,
  "timestamp": 1762612345678,
  "allowedModes": ["465-tls", "2525-starttls"]
}
```

GET /config
```
curl http://localhost:8080/config

{
  "port": 8080,
  "requestBodyLimit": "2mb",
  "rateLimit": { "windowMs": 60000, "max": 30 },
  "corsOrigins": [],
  "trustProxy": 1,
  "metricsEnabled": false,
  "allowedModes": ["465-tls", "2525-starttls"]
}
```

GET /smtp-modes (проверка портов/рукопожатия)
```
curl "http://localhost:8080/smtp-modes?host=smtp.timeweb.ru"

{
  "host": "smtp.timeweb.ru",
  "results": [
    { "mode": "465-tls",   "port": 465,  "secure": true,  "ok": false, "error": { "code": "ETIMEDOUT", "message": "..." } },
    { "mode": "2525-starttls", "port": 2525, "secure": false, "ok": true },
    { "mode": "25-starttls",   "port": 25,   "secure": false, "ok": false, "error": { "code": "ECONNECTION", "message": "..." } }
  ]
}
```
Пояснение: `ok: true` означает, что порт/рукопожатие доступны (без аутентификации).

Политика режимов (422 при запрете)
```
# Пример политики
SMTP_ALLOWED_MODES=2525-starttls

# Запрос в запрещённом режиме (465)
POST /send-mail -> 422
{
  "error": "Mode not allowed",
  "details": { "mode": "465-tls", "allowed": ["2525-starttls"] }
}
```

curl — быстро
1) TLS 465 с идемпотентностью
```
curl -X POST http://localhost:8080/send-mail \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7d9ad0d5-6f6e-48e5-8c6f-6f1d7c7b3f21" \
  -d '{
    "smtp": {"host":"smtp.timeweb.ru","port":465,"secure":true,"username":"no-reply@yourdomain.ru","password":"MAILBOX_PASSWORD"},
    "message": {"from":"no-reply@yourdomain.ru","to":["recipient@example.com"],"subject":"Тест","text":"Hello"}
  }'
```
2) STARTTLS 2525
```
curl -X POST http://localhost:8080/send-mail \
  -H "Content-Type: application/json" \
  -d '{
    "smtp": {"host":"smtp.timeweb.ru","port":2525,"secure":false,"username":"no-reply@yourdomain.ru","password":"MAILBOX_PASSWORD"},
    "message": {"from":"no-reply@yourdomain.ru","to":["recipient@example.com"],"subject":"Тест","text":"Hello"}
  }'
```
3) С Basic Auth (если включено)
```
curl -u api:strong-pass -X POST http://localhost:8080/send-mail \
  -H "Content-Type: application/json" -d '{ ... }'
```

Примечания (Timeweb)
- Логин — полный e‑mail, пароль — пароль почтового ящика.
- 465 (SSL/TLS) или 25/2525 (STARTTLS). На VPS часто блокированы 25/465 — используйте 2525.
