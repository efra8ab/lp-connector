const request = require('supertest');
const { getServer } = require('../src/index');
const { decoded } = require('@app-connect/core/lib/encode');

const appConnectRedirectUri = 'https://ringcentral.github.io/ringcentral-embeddable/redirect.html';

describe('LeadPerfection sign-in routes', () => {
    afterEach(() => {
        delete process.env.LP_ALLOWED_REDIRECT_URIS;
    });

    test('renders the sign-in form for the App Connect redirect page', async () => {
        const res = await request(getServer())
            .get('/leadperfection/auth')
            .query({
                redirect_uri: appConnectRedirectUri,
                state: 'platform=leadperfection&hostname=v6nka.leadperfection.com'
            });

        expect(res.status).toBe(200);
        expect(res.text).toContain('name="password"');
        expect(res.text).toContain('value="v6nka.leadperfection.com"');
    });

    test('escapes request values reflected into the sign-in page', async () => {
        const res = await request(getServer())
            .get('/leadperfection/auth')
            .query({
                redirect_uri: `${appConnectRedirectUri}?x="><script>alert(1)</script>`,
                state: '"><script>alert(2)</script>',
                hostname: '"><img src=x onerror=alert(3)>'
            });

        expect(res.status).toBe(200);
        expect(res.text).not.toContain('<script>alert');
        expect(res.text).not.toContain('<img src=x');
        expect(res.text).toContain('&quot;&gt;&lt;img src=x onerror=alert(3)&gt;');
    });

    test('rejects a sign-in page request that would redirect to another site', async () => {
        const res = await request(getServer())
            .get('/leadperfection/auth')
            .query({ redirect_uri: 'https://attacker.example/collect', state: 'platform=leadperfection' });

        expect(res.status).toBe(400);
        expect(res.text).not.toContain('name="password"');
    });

    test('never sends submitted credentials to an unregistered redirect', async () => {
        const res = await request(getServer())
            .post('/leadperfection/auth')
            .type('form')
            .send({
                redirect_uri: 'https://attacker.example/collect',
                state: 'platform=leadperfection',
                username: 'agent',
                password: 'secret'
            });

        expect(res.status).toBe(400);
        expect(res.headers.location).toBeUndefined();
    });

    test('redirects submitted credentials, encrypted, to the App Connect redirect page', async () => {
        const res = await request(getServer())
            .post('/leadperfection/auth')
            .type('form')
            .send({
                redirect_uri: appConnectRedirectUri,
                state: 'platform=leadperfection',
                hostname: 'v6nka.leadperfection.com',
                username: 'agent',
                password: 'secret'
            });

        expect(res.status).toBe(302);
        const location = new URL(res.headers.location);
        expect(`${location.origin}${location.pathname}`).toBe(appConnectRedirectUri);
        expect(location.searchParams.get('state')).toBe('platform=leadperfection');
        expect(res.headers.location).not.toContain('secret');
        expect(JSON.parse(decoded(location.searchParams.get('code')))).toMatchObject({
            username: 'agent',
            password: 'secret'
        });
    });

    test('accepts redirect pages configured in LP_ALLOWED_REDIRECT_URIS', async () => {
        process.env.LP_ALLOWED_REDIRECT_URIS = `${appConnectRedirectUri}, https://extension.example/callback`;

        const res = await request(getServer())
            .get('/leadperfection/auth')
            .query({ redirect_uri: 'https://extension.example/callback', state: 'platform=leadperfection' });

        expect(res.status).toBe(200);
        expect(res.text).toContain('name="password"');
    });
});
