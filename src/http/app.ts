//src/http/app.ts
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { login } from '../auth/login.js';
import { authenticate, revokeSession } from '../auth/sessions.js';
import { listStaff, createStaff, deactivateStaff, resetStaffPassword, changeOwnPassword } from '../auth/staff.js';
import { LoginLimiter } from './rateLimit.js';
import { Failure } from '../common/result.js';
import { verifyPassword } from '../auth/passwords.js';
import { listLocations, listResources, listDayBookings, getBookingDetail } from '../read/queries.js';
import { createBooking } from '../booking/createBooking.js';
import { markArrived, cancelBooking, releaseBooking } from '../booking/actions.js';
import { recordPayment, recordRefund } from '../cash/payments.js';
import { dailyCashReport } from '../cash/report.js';
import { createLocation, updateLocation, createResource, updateResource, listBlocks, createBlock, deleteBlock } from '../catalog/catalog.js';
import { registerStatic } from './static.js';

interface AppDeps {
  pool: Pool;
  now?: () => Date;
  limiter?: LoginLimiter;
  verifyPassword?: typeof verifyPassword;
  corsOrigins?: string[];
  staticDir?: string;
  production?: boolean;
  logger?: boolean | object;
}

function sendFailure(reply: FastifyReply, failure: Failure) {
  return reply.code(failure.http).send({ error: { code: failure.code, reason: failure.reason, message: failure.message } });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  if (deps.corsOrigins) {
    if (!Array.isArray(deps.corsOrigins) || deps.corsOrigins.includes('*')) {
      throw new Error('corsOrigins must be an array of specific origins, no wildcards allowed');
    }
  }

  const loggerConfig = deps.logger !== undefined ? deps.logger : false;

  const app = Fastify({
    logger: loggerConfig,
    bodyLimit: 102400,
    trustProxy: process.env.TRUST_PROXY === 'true',
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }
  });

  const nowFn = deps.now || (() => new Date());
  const limiter = deps.limiter || new LoginLimiter({ now: nowFn });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'no-store');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    
    if (deps.production) {
      reply.header('Strict-Transport-Security', 'max-age=15552000');
    }
    
    const origin = request.headers.origin;
    if (origin && deps.corsOrigins && deps.corsOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    return payload;
  });

  app.options('/*', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && deps.corsOrigins && deps.corsOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      reply.header('Access-Control-Max-Age', '600');
      reply.header('Vary', 'Origin');
    }
    return reply.code(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    if ((error as any).failure) {
      return sendFailure(reply, (error as any).failure as Failure);
    }
    
    const statusCode = (error as any).statusCode;
    if (statusCode === 413) {
      return reply.code(413).send({ error: { code: 'payload_too_large', message: 'Payload too large' } });
    }
    
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(400).send({ error: { code: 'validation_error', message: 'Invalid request' } });
    }

    const err = error instanceof Error ? error : new Error(String(error));
    request.log.error(`${err.message}\n${err.stack}`);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  const authHook = async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } });
    }
    const token = authHeader.substring(7);
    const result = await authenticate(deps.pool, token, { now: nowFn() });
    if (!result.ok) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } });
    }
    (request as any).auth = result.auth;
  };

  app.get('/health', async (request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch (err) {
      return reply.code(503).send({ error: { code: 'unavailable', message: 'Database unavailable' } });
    }
  });

  app.post('/api/v1/auth/login', {
    schema: {
      body: {
        type: 'object',
        properties: {
          orgSlug: { type: 'string', maxLength: 255 },
          email: { type: 'string', maxLength: 255 },
          password: { type: 'string', maxLength: 255 }
        },
        required: ['orgSlug', 'email', 'password'],
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const body = request.body as any;
    const accountKey = `${body.orgSlug.trim().toLowerCase()}|${body.email.trim().toLowerCase()}`;
    const check = limiter.check(request.ip, accountKey);
    
    if (!check.allowed) {
      reply.header('Retry-After', check.retryAfterSeconds);
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }

    const result = await login(deps.pool, body, { now: nowFn, verifyPassword: deps.verifyPassword });
    
    if (!result.ok) {
      limiter.recordFailure(request.ip, accountKey);
      return sendFailure(reply, result);
    }

    limiter.reset(request.ip, accountKey);
    return { token: result.token, expiresAt: result.expiresAt, user: result.user };
  });

  app.register(async (app) => {
    app.addHook('preHandler', authHook);

    app.post('/api/v1/auth/logout', async (request, reply) => {
      const auth = (request as any).auth;
      await revokeSession(deps.pool, { orgId: auth.orgId, sessionId: auth.sessionId });
      return reply.code(204).send();
    });

    app.get('/api/v1/auth/me', async (request, reply) => {
      const auth = (request as any).auth;
      return {
        user: { id: auth.userId, email: auth.email, fullName: auth.fullName, role: auth.role },
        session: { expiresAt: auth.expiresAt }
      };
    });

    app.post('/api/v1/auth/password', {
      schema: {
        body: {
          type: 'object',
          properties: {
            currentPassword: { type: 'string', maxLength: 255 },
            newPassword: { type: 'string', maxLength: 255 }
          },
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const body = request.body as any;
      const result = await changeOwnPassword(deps.pool, {
        orgId: auth.orgId, userId: auth.userId, currentPassword: body.currentPassword, newPassword: body.newPassword, keepSessionId: auth.sessionId
      });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(204).send();
    });

    app.get('/api/v1/staff', async (request, reply) => {
      const auth = (request as any).auth;
      const result = await listStaff(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId });
      if (!result.ok) return sendFailure(reply, result);
      return { staff: result.staff };
    });

    app.post('/api/v1/staff', {
      schema: {
        body: {
          type: 'object',
          properties: {
            email: { type: 'string', maxLength: 255 },
            fullName: { type: 'string', maxLength: 255 },
            role: { type: 'string', maxLength: 50 },
            password: { type: 'string', maxLength: 255 }
          },
          required: ['email', 'fullName', 'role', 'password'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const body = request.body as any;
      const result = await createStaff(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, email: body.email, fullName: body.fullName, role: body.role, password: body.password });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(201).send({ user: result.user });
    });

    app.post('/api/v1/staff/:id/deactivate', {
      schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } }, additionalProperties: false }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const result = await deactivateStaff(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, targetUserId: params.id });
      if (!result.ok) return sendFailure(reply, result);
      return { ok: true };
    });

    app.post('/api/v1/staff/:id/password', {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } },
        body: { type: 'object', properties: { newPassword: { type: 'string', maxLength: 255 } }, required: ['newPassword'], additionalProperties: false }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const body = request.body as any;
      const result = await resetStaffPassword(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, targetUserId: params.id, newPassword: body.newPassword });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(204).send();
    });

    app.get('/api/v1/locations', async (request, reply) => {
      const auth = (request as any).auth;
      const result = await listLocations(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId });
      if (!result.ok) return sendFailure(reply, result);
      return { locations: result.locations };
    });

    app.post('/api/v1/locations', {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 1000 },
            timezone: { type: 'string', maxLength: 1000 },
            openHour: { type: 'string', maxLength: 1000 },
            closeHour: { type: 'string', maxLength: 1000 }
          },
          required: ['name', 'timezone', 'openHour', 'closeHour'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const body = request.body as any;
      const result = await createLocation(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, ...body }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(201).send({ location: result.location });
    });

    app.patch('/api/v1/locations/:id', {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 1000 },
            timezone: { type: 'string', maxLength: 1000 },
            openHour: { type: 'string', maxLength: 1000 },
            closeHour: { type: 'string', maxLength: 1000 }
          },
          minProperties: 1,
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const body = request.body as any;
      const result = await updateLocation(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, locationId: params.id, ...body }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return { location: result.location };
    });

    app.get('/api/v1/resources', {
      schema: {
        querystring: {
          type: 'object',
          properties: { 
            locationId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
            includeRetired: { type: 'string', enum: ['true', 'false'] }
          },
          required: ['locationId'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const query = request.query as any;
      const result = await listResources(deps.pool, { 
        orgId: auth.orgId, 
        actorUserId: auth.userId, 
        locationId: query.locationId,
        includeRetired: query.includeRetired === 'true'
      });
      if (!result.ok) return sendFailure(reply, result);
      return { resources: result.resources };
    });

    app.post('/api/v1/resources', {
      schema: {
        body: {
          type: 'object',
          properties: {
            locationId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
            type: { type: 'string', maxLength: 1000 },
            name: { type: 'string', maxLength: 1000 },
            capacity: { type: 'integer' },
            hourlyRateCents: { type: 'integer' },
            dayRateCents: { type: 'integer' },
            status: { type: 'string', maxLength: 1000 }
          },
          required: ['locationId', 'type', 'name', 'hourlyRateCents', 'dayRateCents'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const body = request.body as any;
      const result = await createResource(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, ...body }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(201).send({ resource: result.resource });
    });

    app.patch('/api/v1/resources/:id', {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 1000 },
            capacity: { type: 'integer' },
            hourlyRateCents: { type: 'integer' },
            dayRateCents: { type: 'integer' },
            status: { type: 'string', maxLength: 1000 }
          },
          minProperties: 1,
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const body = request.body as any;
      const result = await updateResource(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, resourceId: params.id, ...body }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return { resource: result.resource, activeFutureBookings: result.activeFutureBookings };
    });

    app.get('/api/v1/bookings', {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            locationId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            includeCancelled: { type: 'string', enum: ['true', 'false'] }
          },
          required: ['locationId', 'date'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const query = request.query as any;
      const result = await listDayBookings(deps.pool, { 
        orgId: auth.orgId, 
        actorUserId: auth.userId, 
        locationId: query.locationId, 
        date: query.date, 
        includeCancelled: query.includeCancelled === 'true' 
      });
      if (!result.ok) return sendFailure(reply, result);
      return { date: result.date, locationId: result.locationId, timezone: result.timezone, bookings: result.bookings };
    });

    app.get('/api/v1/bookings/:id', {
      schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } }, additionalProperties: false }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const result = await getBookingDetail(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, bookingId: params.id });
      if (!result.ok) return sendFailure(reply, result);
      return { booking: result.booking, balance: result.balance, payments: result.payments };
    });

    app.post('/api/v1/bookings', {
      schema: {
        body: {
          type: 'object',
          properties: {
            resourceId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
            kind: { type: 'string', enum: ['hourly', 'day'] },
            start: { type: 'string' },
            end: { type: 'string' },
            date: { type: 'string' },
            customerName: { type: 'string', minLength: 1, maxLength: 200 },
            customerPhone: { type: 'string', minLength: 1, maxLength: 50 },
            arrivedNow: { type: 'boolean' }
          },
          required: ['resourceId', 'customerName'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const body = request.body as any;
      const result = await createBooking(deps.pool, {
        orgId: auth.orgId,
        userId: auth.userId,
        resourceId: body.resourceId,
        kind: body.kind,
        start: body.start,
        end: body.end,
        date: body.date,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        arrivedNow: body.arrivedNow
      }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(201).send({ booking: result.booking });
    });

    app.post('/api/v1/bookings/:id/arrived', {
      schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } }, additionalProperties: false },
      preValidation: async (request, reply) => {
        if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Object.keys(request.body).length > 0)) {
          return reply.code(400).send({ error: { code: 'validation_error', message: 'Invalid request' } });
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const result = await markArrived(deps.pool, { orgId: auth.orgId, bookingId: params.id, actorUserId: auth.userId }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return { booking: result.booking };
    });

    app.post('/api/v1/bookings/:id/cancel', {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } },
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string', maxLength: 500 },
            refundCents: { type: 'integer', minimum: 1, maximum: 2000000000 }
          },
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const body = request.body as any;
      const result = await cancelBooking(deps.pool, { orgId: auth.orgId, bookingId: params.id, actorUserId: auth.userId, reason: body.reason, refundCents: body.refundCents }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return { booking: result.booking, refund: result.refund };
    });

    app.post('/api/v1/bookings/:id/release', {
      schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } }, additionalProperties: false },
      preValidation: async (request, reply) => {
        if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Object.keys(request.body).length > 0)) {
          return reply.code(400).send({ error: { code: 'validation_error', message: 'Invalid request' } });
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const result = await releaseBooking(deps.pool, { orgId: auth.orgId, bookingId: params.id, actorUserId: auth.userId }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return { booking: result.booking };
    });

    app.post('/api/v1/bookings/:id/payments', {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } },
        body: {
          type: 'object',
          properties: {
            amountCents: { type: 'integer', minimum: 1, maximum: 2000000000 },
            note: { type: 'string', maxLength: 500 }
          },
          required: ['amountCents'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const body = request.body as any;
      const result = await recordPayment(deps.pool, { orgId: auth.orgId, bookingId: params.id, actorUserId: auth.userId, amountCents: body.amountCents, note: body.note }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(201).send({ payment: result.payment, balance: result.balance });
    });

    app.post('/api/v1/bookings/:id/refunds', {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } },
        body: {
          type: 'object',
          properties: {
            amountCents: { type: 'integer', minimum: 1, maximum: 2000000000 },
            note: { type: 'string', maxLength: 500 }
          },
          required: ['amountCents'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const body = request.body as any;
      const result = await recordRefund(deps.pool, { orgId: auth.orgId, bookingId: params.id, actorUserId: auth.userId, amountCents: body.amountCents, note: body.note }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(201).send({ payment: result.payment, balance: result.balance });
    });

    app.get('/api/v1/cash/daily', {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            locationId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
          },
          required: ['locationId', 'date'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const query = request.query as any;
      const result = await dailyCashReport(deps.pool, { orgId: auth.orgId, locationId: query.locationId, date: query.date, actorUserId: auth.userId }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return { date: result.date, locationId: result.locationId, timezone: result.timezone, staff: result.staff, totals: result.totals };
    });

    app.get('/api/v1/resources/:id/blocks', {
      schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } }, additionalProperties: false }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const result = await listBlocks(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, resourceId: params.id }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return { blocks: result.blocks };
    });

    app.post('/api/v1/resources/:id/blocks', {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } },
        body: {
          type: 'object',
          properties: {
            start: { type: 'string', maxLength: 1000 },
            end: { type: 'string', maxLength: 1000 },
            reason: { type: 'string', maxLength: 1000 }
          },
          required: ['start', 'end'],
          additionalProperties: false
        }
      }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const body = request.body as any;
      const result = await createBlock(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, resourceId: params.id, ...body }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(201).send({ block: result.block });
    });

    app.delete('/api/v1/blocks/:id', {
      schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } }, additionalProperties: false }
    }, async (request, reply) => {
      const auth = (request as any).auth;
      const params = request.params as any;
      const result = await deleteBlock(deps.pool, { orgId: auth.orgId, actorUserId: auth.userId, blockId: params.id }, { now: nowFn() });
      if (!result.ok) return sendFailure(reply, result);
      return reply.code(204).send();
    });
  });

  if (deps.staticDir) {
    registerStatic(app, deps.staticDir);
  }

  return app;
}