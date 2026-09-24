const { normalizeBaseUrl, runHostedSmoke } = require('../scripts/hosted-smoke');

function response(status, body) {
    return {
        status,
        text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body))
    };
}

function createFetch(overrides = {}) {
    const baseUrl = 'https://connector.example.com';
    const manifest = {
        serverUrl: baseUrl,
        platforms: {
            leadperfection: {
                auth: { oauth: { authUrl: `${baseUrl}/leadperfection/auth` } },
                page: {
                    callLog: {
                        additionalFields: [
                            { const: 'resultCode', type: 'selection', options: [{ const: 'NA' }] },
                            { const: 'callType', type: 'selection', options: [{ const: 'O' }] }
                        ]
                    }
                }
            }
        }
    };
    const routes = {
        [`${baseUrl}/isAlive`]: response(200, 'OK'),
        [`${baseUrl}/crmManifest?platformName=leadperfection`]: response(200, manifest),
        [`${baseUrl}/implementedInterfaces?platform=leadperfection`]: response(200, {
            getOauthInfo: true,
            getUserInfo: true,
            findContact: true,
            createCallLog: true,
            unAuthorize: true
        }),
        ...overrides
    };
    return jest.fn(async (url) => {
        if (routes[url]) {
            return routes[url];
        }
        if (url.startsWith(`${baseUrl}/leadperfection/auth?`)) {
            const params = new URL(url).searchParams;
            if (!params.get('redirect_uri').startsWith('https://ringcentral.github.io/')) {
                return response(400, 'This sign-in link is not valid.');
            }
            return response(200, '<title>LeadPerfection Sign In</title><input name="username"><input name="password">');
        }
        return response(404, 'Not found');
    });
}

describe('hosted smoke test', () => {
    test('normalizes a valid HTTPS base URL', () => {
        expect(normalizeBaseUrl('https://connector.example.com/')).toBe('https://connector.example.com');
    });

    test('rejects an insecure hosted URL', () => {
        expect(() => normalizeBaseUrl('http://connector.example.com')).toThrow('must use HTTPS');
    });

    test('passes when all public hosted surfaces are ready', async () => {
        const report = await runHostedSmoke('https://connector.example.com', { fetchFn: createFetch() });

        expect(report.passed).toBe(true);
        expect(report.checks).toHaveLength(5);
        expect(report.checks.every(item => item.status === 'passed')).toBe(true);
    });

    test('fails when the manifest sends API traffic to another server', async () => {
        const badManifest = {
            serverUrl: 'https://unified-crm-extension.labs.ringcentral.com',
            platforms: { leadperfection: {} }
        };
        const fetchFn = createFetch({
            'https://connector.example.com/crmManifest?platformName=leadperfection': response(200, badManifest)
        });

        const report = await runHostedSmoke('https://connector.example.com', { fetchFn });

        expect(report.passed).toBe(false);
        expect(report.checks.find(item => item.name === 'LeadPerfection manifest wiring').error)
            .toContain('Manifest serverUrl');
    });

    test('fails when the sign-in page accepts a foreign redirect', async () => {
        const fetchFn = createFetch();
        const permissiveFetch = jest.fn(async (url) => {
            if (url.includes('smoke-test.invalid')) {
                return response(200, '<title>LeadPerfection Sign In</title>');
            }
            return fetchFn(url);
        });

        const report = await runHostedSmoke('https://connector.example.com', { fetchFn: permissiveFetch });

        expect(report.passed).toBe(false);
        expect(report.checks.find(item => item.name === 'Sign-in page hardening').error)
            .toContain('foreign redirect_uri');
    });

    test('checks the Developer Console manifest when its URL is provided', async () => {
        const consoleManifestUrl = 'https://appconnect.example.com/public-api/connectors/1/manifest';
        const fetchFn = createFetch({
            [consoleManifestUrl]: response(200, {
                version: '0.0.3',
                serverUrl: 'https://neon-drowsily-irritably.ngrok-free.dev',
                auth: { oauth: { authUrl: 'https://neon-drowsily-irritably.ngrok-free.dev/leadperfection/auth' } }
            })
        });

        const report = await runHostedSmoke('https://connector.example.com', { fetchFn, consoleManifestUrl });

        expect(report.passed).toBe(false);
        expect(report.checks.find(item => item.name === 'Developer Console manifest routing').error)
            .toContain('Console serverUrl');
    });

    test('passes the Developer Console check when it points at the hosted service', async () => {
        const consoleManifestUrl = 'https://appconnect.example.com/public-api/connectors/1/manifest';
        const fetchFn = createFetch({
            [consoleManifestUrl]: response(200, {
                version: '0.0.3',
                serverUrl: 'https://connector.example.com',
                auth: { oauth: { authUrl: 'https://connector.example.com/leadperfection/auth' } }
            })
        });

        const report = await runHostedSmoke('https://connector.example.com', { fetchFn, consoleManifestUrl });

        expect(report.passed).toBe(true);
        expect(report.checks).toHaveLength(6);
    });
});
