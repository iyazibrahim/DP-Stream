'use strict';

const crypto = require('crypto');
const fp = require('fastify-plugin');

async function csrfPlugin(fastify) {
  // Set a CSRF cookie on every non-asset GET response when the cookie is absent.
  // The cookie is NOT httpOnly so client-side JS can read it for XHR/fetch calls.
  fastify.addHook('onSend', async function (request, reply, payload) {
    if (request.method === 'GET' && !request.cookies.csrf_token) {
      const url = request.url.split('?')[0];
      const skip =
        url.startsWith('/media/') ||
        url.startsWith('/public/') ||
        url === '/health';
      if (!skip) {
        const token = crypto.randomBytes(32).toString('hex');
        reply.setCookie('csrf_token', token, {
          path: '/',
          httpOnly: false,   // JS must read this for XHR/fetch
          sameSite: 'strict',
          secure: false,     // switch to true when behind HTTPS
          maxAge: 86400      // 24 hours
        });
      }
    }
    return payload;
  });

  // Reject any state-changing request that does not supply a valid CSRF token.
  // Checks (in order):
  //   1. X-CSRF-Token request header  (XHR/fetch)
  //   2. _csrf body field             (URL-encoded form submissions)
  //
  // Multipart bodies are NOT parsed in this hook; those routes must be called
  // via fetch/XHR with the X-CSRF-Token header set (see head.ejs JS).
  fastify.addHook('preHandler', async function (request, reply) {
    if (
      request.method === 'GET' ||
      request.method === 'HEAD' ||
      request.method === 'OPTIONS'
    ) {
      return;
    }

    const cookieToken = request.cookies.csrf_token;
    const headerToken = request.headers['x-csrf-token'] || '';
    const contentType = request.headers['content-type'] || '';

    // Body is only auto-parsed for application/x-www-form-urlencoded.
    // For multipart, request.body is empty here — those requests must use the header.
    const bodyToken =
      !contentType.includes('multipart/form-data')
        ? ((request.body && request.body._csrf) || '')
        : '';

    const submittedToken = headerToken || bodyToken;

    if (!cookieToken || !submittedToken) {
      return reply.code(403).send({ error: 'Invalid CSRF token' });
    }

    try {
      const cookieBuf = Buffer.from(cookieToken, 'utf8');
      const submittedBuf = Buffer.from(submittedToken, 'utf8');
      if (
        cookieBuf.length !== submittedBuf.length ||
        !crypto.timingSafeEqual(cookieBuf, submittedBuf)
      ) {
        return reply.code(403).send({ error: 'Invalid CSRF token' });
      }
    } catch {
      return reply.code(403).send({ error: 'Invalid CSRF token' });
    }
  });
}

module.exports = fp(csrfPlugin);
