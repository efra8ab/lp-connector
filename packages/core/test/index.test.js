const express = require('express');
const request = require('supertest');

jest.mock('../lib/jwt', () => ({
  decodeJwt: jest.fn(),
  generateJwt: jest.fn(),
}));
jest.mock('../handlers/auth', () => ({
  authValidation: jest.fn(),
}));
jest.mock('../lib/analytics', () => ({
  init: jest.fn(),
  track: jest.fn(),
}));

const jwt = require('../lib/jwt');
const authCore = require('../handlers/auth');
const { createCoreRouter, createCoreMiddleware } = require('../index');
const connectorRegistry = require('../connector/registry');

function buildApp() {
  const app = express();
  createCoreMiddleware().forEach((m) => app.use(m));
  app.use('/', createCoreRouter());
  return app;
}

describe('Core Router JWT normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should accept query jwtToken without refreshing it', async () => {
    jwt.decodeJwt.mockReturnValue({ id: 'user-1', platform: 'testCRM' });
    authCore.authValidation.mockResolvedValue({
      successful: true,
      returnMessage: { message: 'ok' },
      failReason: null,
      status: 200,
    });
    const app = buildApp();

    const response = await request(app).get('/authValidation?jwtToken=query-token');

    expect(response.status).toBe(200);
    expect(response.headers['x-refreshed-jwt-token']).toBeUndefined();
    expect(authCore.authValidation).toHaveBeenCalledWith({
      platform: 'testCRM',
      userId: 'user-1',
    });
    expect(jwt.generateJwt).not.toHaveBeenCalled();
  });

  test('should refresh near-expiry bearer token and expose header', async () => {
    const nowMs = 1700000000000;
    const nowSeconds = Math.floor(nowMs / 1000);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    jwt.decodeJwt.mockImplementation((token) => {
      if (token === 'old-token') {
        return { id: 'user-1', platform: 'testCRM', exp: nowSeconds + 60 };
      }
      if (token === 'new-token') {
        return { id: 'user-1', platform: 'testCRM', exp: nowSeconds + (14 * 24 * 60 * 60) };
      }
      return null;
    });
    jwt.generateJwt.mockReturnValue('new-token');
    const app = buildApp();

    const response = await request(app)
      .get('/isAlive')
      .set('Authorization', 'Bearer old-token')
      .set('Origin', 'https://example.com');

    expect(response.status).toBe(200);
    expect(response.headers['x-refreshed-jwt-token']).toBe('new-token');
    expect(response.headers['access-control-expose-headers']).toContain('x-refreshed-jwt-token');
    expect(jwt.generateJwt).toHaveBeenCalledWith({ id: 'user-1', platform: 'testCRM' });
    nowSpy.mockRestore();
  });

  test('should treat invalid bearer token as unauthenticated for authValidation route', async () => {
    jwt.decodeJwt.mockReturnValue(null);
    const app = buildApp();

    const response = await request(app)
      .get('/authValidation?jwtToken=query-token')
      .set('Authorization', 'Bearer invalid-token');

    expect(response.status).toBe(400);
    expect(response.text).toContain('authorize CRM platform');
    expect(authCore.authValidation).not.toHaveBeenCalled();
  });

  test('should bypass normalization for /mcp routes', async () => {
    const app = buildApp();

    const response = await request(app)
      .get('/mcp')
      .set('Authorization', 'Bearer maybe-token');

    expect(response.status).toBe(404);
    expect(jwt.decodeJwt).not.toHaveBeenCalled();
  });
});

describe('Core Router hosted manifest', () => {
  const originalAppServer = process.env.APP_SERVER;
  const originalOverrideAppServer = process.env.OVERRIDE_APP_SERVER;

  beforeEach(() => {
    connectorRegistry.setDefaultManifest({
      serverUrl: 'https://upstream.example.com',
      author: { name: 'Test' },
      platforms: {
        leadperfection: {
          auth: {
            oauth: {
              authUrl: '__APP_SERVER__/leadperfection/auth',
            },
          },
        },
      },
    });
    process.env.APP_SERVER = 'https://hosted.example.com';
    delete process.env.OVERRIDE_APP_SERVER;
  });

  afterAll(() => {
    if (originalAppServer === undefined) {
      delete process.env.APP_SERVER;
    } else {
      process.env.APP_SERVER = originalAppServer;
    }
    if (originalOverrideAppServer === undefined) {
      delete process.env.OVERRIDE_APP_SERVER;
    } else {
      process.env.OVERRIDE_APP_SERVER = originalOverrideAppServer;
    }
  });

  test('uses APP_SERVER for the manifest API and authorization URLs', async () => {
    const response = await request(buildApp()).get('/crmManifest?platformName=leadperfection');

    expect(response.status).toBe(200);
    expect(response.body.serverUrl).toBe('https://hosted.example.com');
    expect(response.body.platforms.leadperfection.auth.oauth.authUrl)
      .toBe('https://hosted.example.com/leadperfection/auth');
  });

  test('prefers OVERRIDE_APP_SERVER when it is explicitly configured', async () => {
    process.env.OVERRIDE_APP_SERVER = 'https://override.example.com';

    const response = await request(buildApp()).get('/crmManifest?platformName=leadperfection');

    expect(response.status).toBe(200);
    expect(response.body.serverUrl).toBe('https://override.example.com');
    expect(response.body.platforms.leadperfection.auth.oauth.authUrl)
      .toBe('https://override.example.com/leadperfection/auth');
  });
});
