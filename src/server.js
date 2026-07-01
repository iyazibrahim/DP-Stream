require('dotenv').config();

const Fastify = require('fastify');
const path = require('path');

const dbPlugin = require('./plugins/db');
const authPlugin = require('./plugins/auth');
const migrationService = require('./services/migrationService');
const settingsService = require('./services/settingsService');

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const videoRoutes = require('./routes/videoRoutes');
const pageRoutes = require('./routes/pageRoutes');

async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(require('@fastify/cookie'));
  await app.register(require('@fastify/formbody'));
  await app.register(require('@fastify/multipart'), {
    limits: { fileSize: 20 * 1024 * 1024 * 1024 }
  });
  await app.register(require('@fastify/rate-limit'), {
    global: false,
    max: 20,
    timeWindow: '1 minute'
  });

  await app.register(require('@fastify/view'), {
    engine: { ejs: require('ejs') },
    root: path.join(__dirname, 'views')
  });

  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', 'media'),
    prefix: '/media/'
  });

  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/public/',
    decorateReply: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  });

  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(require('./plugins/csrf'));

  await app.register(pageRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(videoRoutes, { prefix: '/videos' });

  app.get('/health', async () => ({ ok: true }));

  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode || 500;
    if (request.url.startsWith('/auth') || request.url.startsWith('/admin') || request.url.startsWith('/videos')) {
      return reply.status(statusCode).send({ error: error.message || 'Internal Server Error' });
    }
    return reply.status(statusCode).view('error.ejs', { message: error.message || 'Something went wrong' });
  });

  await migrationService.runMigrations(app.log);
  await settingsService.ensureDefaults(app);
  return app;
}

buildServer()
  .then(async (app) => {
    const port = Number(process.env.PORT || 3000);
    const host = '0.0.0.0';
    await app.listen({ port, host });
    app.log.info(`Server listening on ${host}:${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
