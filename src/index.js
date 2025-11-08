const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ipaddr = require('ipaddr.js');
const pino = require('pino');
const pinoHttp = require('pino-http');
const nodemailer = require('nodemailer');
const { z } = require('zod');
const client = require('prom-client');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const TRUST_PROXY = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1;
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '1mb';
const RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS ? Number(process.env.RATE_LIMIT_WINDOW_MS) : 60_000;
const RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : 30;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || '';
const IP_ALLOWLIST = (process.env.IP_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
const ENABLE_METRICS = (process.env.ENABLE_METRICS || 'false').toLowerCase() === 'true';
const IDEMPOTENCY_TTL_SECONDS = process.env.IDEMPOTENCY_TTL_SECONDS ? Number(process.env.IDEMPOTENCY_TTL_SECONDS) : 600;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SMTP_CONNECTION_TIMEOUT_MS = process.env.SMTP_CONNECTION_TIMEOUT_MS ? Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) : 15_000;
const SMTP_GREETING_TIMEOUT_MS = process.env.SMTP_GREETING_TIMEOUT_MS ? Number(process.env.SMTP_GREETING_TIMEOUT_MS) : 15_000;
const SMTP_SOCKET_TIMEOUT_MS = process.env.SMTP_SOCKET_TIMEOUT_MS ? Number(process.env.SMTP_SOCKET_TIMEOUT_MS) : 30_000;
const MAIL_SEND_TIMEOUT_MS = process.env.MAIL_SEND_TIMEOUT_MS ? Number(process.env.MAIL_SEND_TIMEOUT_MS) : 45_000;
const SMTP_ALLOWED_MODES = (process.env.SMTP_ALLOWED_MODES || '').split(',').map(s => s.trim()).filter(Boolean);

function parseAllowedModes(modes) {
  if (!modes || modes.length === 0) return null; // null => allow all
  const parsed = [];
  for (const m of modes) {
    const [portStr, kind] = m.split('-');
    const port = Number(portStr);
    if (!port || !kind) continue;
    const labelKind = kind.toLowerCase();
    const secure = labelKind === 'tls';
    if (!secure && labelKind !== 'starttls') continue;
    parsed.push({ port, secure, label: `${port}-${secure ? 'tls' : 'starttls'}` });
  }
  return parsed.length ? parsed : null;
}
const allowedModes = parseAllowedModes(SMTP_ALLOWED_MODES);

// Logger with redaction
const logger = pino({
  level: LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.body.smtp.password'],
    remove: true,
  },
});

const httpLogger = pinoHttp({
  logger,
  customLogLevel: function (req, res, err) {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});

const app = express();
app.set('trust proxy', TRUST_PROXY);

// Metrics
let metrics = {};
if (ENABLE_METRICS) {
  client.collectDefaultMetrics();
  metrics.reqCounter = new client.Counter({ name: 'api_requests_total', help: 'Total API requests', labelNames: ['route', 'method', 'status'] });
  metrics.reqDuration = new client.Histogram({ name: 'api_request_duration_ms', help: 'Request duration', labelNames: ['route', 'method', 'status'], buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000] });
}

// Middlewares
app.use(httpLogger);
app.use(helmet());
app.use(express.json({ limit: BODY_LIMIT }));

// CORS allowlist
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: false,
};
app.use(cors(corsOptions));

// Basic Auth (optional)
if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="API"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const [user, pass] = decoded.split(':');
    if (user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASS) {
      return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="API"');
    return res.status(401).json({ error: 'Unauthorized' });
  });
}

// IP allowlist (optional)
function ipAllowed(ip, allowlist) {
  if (allowlist.length === 0) return true;
  try {
    const reqAddr = ipaddr.parse(ip);
    return allowlist.some(entry => {
      try {
        if (entry.includes('/')) {
          const [range, prefix] = entry.split('/');
          const rangeAddr = ipaddr.parse(range);
          if (rangeAddr.kind() !== reqAddr.kind()) return false;
          return reqAddr.match(rangeAddr, parseInt(prefix, 10));
        } else {
          const exact = ipaddr.parse(entry);
          return reqAddr.toNormalizedString() === exact.toNormalizedString();
        }
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    return false;
  }
}
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  if (!ipAllowed(ip, IP_ALLOWLIST)) {
    return res.status(401).json({ error: 'Unauthorized IP' });
  }
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});
app.use(limiter);

// Validation schema using zod
const AttachmentSchema = z.object({
  filename: z.string(),
  contentBase64: z.string(),
  contentType: z.string().optional(),
});
const MessageSchema = z.object({
  from: z.string(),
  to: z.array(z.string()).nonempty(),
  cc: z.array(z.string()).optional().default([]),
  bcc: z.array(z.string()).optional().default([]),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  replyTo: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional().default([]),
  headers: z.record(z.string()).optional().default({}),
  customId: z.string().optional(),
}).refine((m) => (m.text && m.text.length) || (m.html && m.html.length), { message: 'Either text or html must be provided', path: ['text'] });
const SmtpSchema = z.object({
  host: z.string().default('smtp.timeweb.ru'),
  port: z.number().int().default(465),
  secure: z.boolean().default(true),
  username: z.string(),
  password: z.string(),
});
const SendMailSchema = z.object({
  smtp: SmtpSchema,
  message: MessageSchema,
});

// Idempotency store
const idempotencyStore = new Map(); // key -> { createdAt, promise, result }
function cleanupIdempotency() {
  const now = Date.now();
  for (const [key, value] of idempotencyStore.entries()) {
    if (value.result) {
      if (now - value.createdAt > IDEMPOTENCY_TTL_SECONDS * 1000) {
        idempotencyStore.delete(key);
      }
    } else {
      if (now - value.createdAt > 5 * 60 * 1000) { // stale pending >5m
        idempotencyStore.delete(key);
      }
    }
  }
}
setInterval(cleanupIdempotency, 60_000).unref();

function getIdempotencyKey(reqBody, req) {
  const headerKey = (req.headers['idempotency-key'] || '').toString().trim();
  const bodyKey = reqBody?.message?.customId || '';
  return headerKey || bodyKey || '';
}

async function sendViaSmtp(reqBody) {
  const { smtp, message } = reqBody;
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    auth: { user: smtp.username, pass: smtp.password },
  });
  const mailOptions = {
    from: message.from,
    to: message.to && message.to.length ? message.to.join(', ') : undefined,
    cc: message.cc && message.cc.length ? message.cc.join(', ') : undefined,
    bcc: message.bcc && message.bcc.length ? message.bcc.join(', ') : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    replyTo: message.replyTo,
    headers: message.headers,
    attachments: (message.attachments || []).map(a => ({
      filename: a.filename,
      content: Buffer.from(a.contentBase64, 'base64'),
      contentType: a.contentType,
    })),
  };
  let info;
  try {
    info = await Promise.race([
      transporter.sendMail(mailOptions),
      new Promise((_, reject) => {
        const e = new Error('SEND_TIMEOUT');
        e.code = 'SEND_TIMEOUT';
        setTimeout(() => reject(e), MAIL_SEND_TIMEOUT_MS);
      })
    ]);
  } catch (e) {
    try { transporter.close(); } catch (_) {}
    throw e;
  }
  return {
    id: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
    response: info.response,
    envelope: info.envelope,
  };
}

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now(), allowedModes: allowedModes ? allowedModes.map(m => m.label) : 'all' });
});

if (ENABLE_METRICS) {
  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', client.register.contentType);
      res.end(await client.register.metrics());
    } catch (err) {
      res.status(500).end(err.message);
    }
  });
}

// Config endpoint (no secrets)
app.get('/config', (req, res) => {
  res.json({
    port: PORT,
    requestBodyLimit: BODY_LIMIT,
    rateLimit: { windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX },
    corsOrigins: CORS_ORIGINS,
    trustProxy: TRUST_PROXY,
    metricsEnabled: ENABLE_METRICS,
    allowedModes: allowedModes ? allowedModes.map(m => m.label) : 'all',
  });
});

// Connectivity probe for SMTP modes
app.get('/smtp-modes', async (req, res) => {
  const host = (req.query.host || 'smtp.timeweb.ru').toString();
  const listParam = (req.query.modes || '').toString();
  const list = listParam ? parseAllowedModes(listParam.split(',').map(s => s.trim())) : null;
  const toCheck = list || allowedModes || [
    { port: 465, secure: true, label: '465-tls' },
    { port: 2525, secure: false, label: '2525-starttls' },
    { port: 25, secure: false, label: '25-starttls' },
  ];
  const results = [];
  for (const m of toCheck) {
    const transporter = nodemailer.createTransport({
      host,
      port: m.port,
      secure: m.secure,
      requireTLS: !m.secure,
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    });
    try {
      // verify checks reachability; no auth required
      // eslint-disable-next-line no-await-in-loop
      await transporter.verify();
      results.push({ mode: m.label, port: m.port, secure: m.secure, ok: true });
    } catch (e) {
      results.push({ mode: m.label, port: m.port, secure: m.secure, ok: false, error: { code: e.code || e.name, message: e.message, responseCode: e.responseCode } });
    } finally {
      try { transporter.close(); } catch (_) {}
    }
  }
  res.json({ host, results });
});

app.post('/send-mail', async (req, res) => {
  const start = ENABLE_METRICS ? Date.now() : 0;
  try {
    const parsed = SendMailSchema.safeParse(req.body);
    if (!parsed.success) {
      const details = parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
      if (ENABLE_METRICS) {
        metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: '400' });
        metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: '400' }, Date.now() - start);
      }
      return res.status(400).json({ error: 'Bad Request', details });
    }
    const body = parsed.data;

    // Enforce allowed SMTP modes if configured
    if (allowedModes) {
      const modeLabel = `${body.smtp.port}-${body.smtp.secure ? 'tls' : 'starttls'}`;
      const ok = allowedModes.some(m => m.port === body.smtp.port && m.secure === body.smtp.secure);
      if (!ok) {
        if (ENABLE_METRICS) {
          metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: '422' });
          metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: '422' }, Date.now() - start);
        }
        return res.status(422).json({ error: 'Mode not allowed', details: { mode: modeLabel, allowed: allowedModes.map(m => m.label) } });
      }
    }

    const idemKey = getIdempotencyKey(body, req);
    if (idemKey) {
      const existing = idempotencyStore.get(idemKey);
      if (existing) {
        try {
          const result = await existing.promise; // Wait for first
          if (ENABLE_METRICS) {
            metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: '200' });
            metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: '200' }, Date.now() - start);
          }
          return res.json(result);
        } catch (e) {
          // Previous attempt failed; propagate mapped error
          const mapped = mapSmtpError(e);
          if (ENABLE_METRICS) {
            metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: String(mapped.status) });
            metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: String(mapped.status) }, Date.now() - start);
          }
          return res.status(mapped.status).json(mapped.body);
        }
      }

      const promise = (async () => {
        try {
          const result = await sendViaSmtp(body);
          const response = { id: result.id, accepted: result.accepted, rejected: result.rejected };
          idempotencyStore.set(idemKey, { createdAt: Date.now(), promise: Promise.resolve(response), result: response });
          return response;
        } catch (err) {
          throw err;
        }
      })();
      idempotencyStore.set(idemKey, { createdAt: Date.now(), promise, result: null });

      try {
        const response = await promise;
        if (ENABLE_METRICS) {
          metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: '200' });
          metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: '200' }, Date.now() - start);
        }
        return res.json(response);
      } catch (err) {
        idempotencyStore.delete(idemKey); // allow retry after failure
        const mapped = mapSmtpError(err);
        if (ENABLE_METRICS) {
          metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: String(mapped.status) });
          metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: String(mapped.status) }, Date.now() - start);
        }
        return res.status(mapped.status).json(mapped.body);
      }
    } else {
      // No idempotency
      try {
        const result = await sendViaSmtp(body);
        if (ENABLE_METRICS) {
          metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: '200' });
          metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: '200' }, Date.now() - start);
        }
        return res.json({ id: result.id, accepted: result.accepted, rejected: result.rejected });
      } catch (err) {
        const mapped = mapSmtpError(err);
        if (ENABLE_METRICS) {
          metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: String(mapped.status) });
          metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: String(mapped.status) }, Date.now() - start);
        }
        return res.status(mapped.status).json(mapped.body);
      }
    }
  } catch (err) {
    req.log?.error({ err }, 'Unhandled error');
    if (ENABLE_METRICS) {
      metrics.reqCounter?.inc({ route: '/send-mail', method: 'POST', status: '500' });
      metrics.reqDuration?.observe({ route: '/send-mail', method: 'POST', status: '500' }, Date.now() - start);
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

function mapSmtpError(err) {
  const code = err && (err.code || err.name) || '';
  const msg = err && (err.response || err.message || '');
  const details = { code, message: msg };
  if (code === 'EAUTH' || code === 'EENVELOPE' || code === 'EMESSAGE') {
    return { status: 422, body: { error: 'Unprocessable Entity', details } };
  }
  // Nodemailer SMTPError might include responseCode 535 for auth, 550, etc.
  const rc = err && err.responseCode;
  if (rc === 535 || rc === 530 || rc === 550 || rc === 553) {
    return { status: 422, body: { error: 'Unprocessable Entity', details } };
  }
  // Connection / timeout errors
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'EAI_AGAIN' || code === 'SEND_TIMEOUT' || rc === 421) {
    return { status: 504, body: { error: 'Gateway Timeout', details } };
  }
  return { status: 500, body: { error: 'Internal Server Error', details } };
}

app.use((err, req, res, next) => {
  req.log?.error({ err }, 'Request error');
  return res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT, allowedModes: allowedModes ? allowedModes.map(m => m.label) : 'all' }, 'Mail API Proxy listening');
});
