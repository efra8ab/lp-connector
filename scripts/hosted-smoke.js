#!/usr/bin/env node

const DEFAULT_TIMEOUT_MS = 15000;
const APP_CONNECT_REDIRECT_URI = 'https://ringcentral.github.io/ringcentral-embeddable/redirect.html';

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function normalizeBaseUrl(value) {
    assert(value, 'Provide the deployed URL as an argument or set HOSTED_APP_URL.');
    const url = new URL(value);
    assert(url.protocol === 'https:', 'The hosted application URL must use HTTPS.');
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
}

async function request(fetchFn, url, timeoutMs) {
    const startedAt = Date.now();
    const response = await fetchFn(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
            Accept: 'application/json, text/html, text/plain'
        }
    });
    const body = await response.text();
    return {
        status: response.status,
        body,
        durationMs: Date.now() - startedAt
    };
}

function parseJson(body, label) {
    try {
        return JSON.parse(body);
    }
    catch {
        throw new Error(`${label} did not return valid JSON.`);
    }
}

async function runHostedSmoke(baseUrlInput, options = {}) {
    const baseUrl = normalizeBaseUrl(baseUrlInput);
    const fetchFn = options.fetchFn || fetch;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const checks = [];

    async function check(name, run) {
        const startedAt = Date.now();
        try {
            const details = await run();
            checks.push({ name, status: 'passed', durationMs: Date.now() - startedAt, details });
        }
        catch (error) {
            checks.push({ name, status: 'failed', durationMs: Date.now() - startedAt, error: error.message });
        }
    }

    await check('Health endpoint', async () => {
        const result = await request(fetchFn, `${baseUrl}/isAlive`, timeoutMs);
        assert(result.status === 200, `Expected HTTP 200, received ${result.status}.`);
        assert(result.body.trim() === 'OK', `Expected body "OK", received ${JSON.stringify(result.body.trim())}.`);
        return { httpStatus: result.status, responseMs: result.durationMs };
    });

    let manifest;
    await check('LeadPerfection manifest wiring', async () => {
        const result = await request(fetchFn, `${baseUrl}/crmManifest?platformName=leadperfection`, timeoutMs);
        assert(result.status === 200, `Expected HTTP 200, received ${result.status}.`);
        manifest = parseJson(result.body, 'The manifest endpoint');
        const platform = manifest.platforms?.leadperfection;
        assert(platform, 'The LeadPerfection platform is missing from the manifest.');
        assert(manifest.serverUrl === baseUrl,
            `Manifest serverUrl is ${JSON.stringify(manifest.serverUrl)} instead of ${JSON.stringify(baseUrl)}.`);
        const authUrl = platform.auth?.oauth?.authUrl;
        assert(authUrl && !authUrl.includes('__APP_SERVER__'), 'The authorization URL still contains a placeholder.');
        assert(authUrl === `${baseUrl}/leadperfection/auth`,
            `Authorization URL is ${JSON.stringify(authUrl)} instead of the hosted application.`);
        const fields = platform.page?.callLog?.additionalFields || [];
        for (const fieldName of ['resultCode', 'callType']) {
            const field = fields.find(item => item.const === fieldName);
            assert(field?.type === 'selection' && field.options?.length > 0,
                `Call-log field ${fieldName} is missing its selectable options.`);
        }
        return {
            httpStatus: result.status,
            responseMs: result.durationMs,
            serverUrl: manifest.serverUrl,
            authUrl
        };
    });

    await check('LeadPerfection interfaces', async () => {
        const result = await request(fetchFn, `${baseUrl}/implementedInterfaces?platform=leadperfection`, timeoutMs);
        assert(result.status === 200, `Expected HTTP 200, received ${result.status}.`);
        const interfaces = parseJson(result.body, 'The implemented-interfaces endpoint');
        for (const interfaceName of ['getOauthInfo', 'getUserInfo', 'findContact', 'createCallLog', 'unAuthorize']) {
            assert(interfaces[interfaceName] === true, `Required interface ${interfaceName} is not enabled.`);
        }
        return { httpStatus: result.status, responseMs: result.durationMs };
    });

    await check('Hosted sign-in page', async () => {
        const params = new URLSearchParams({
            redirect_uri: APP_CONNECT_REDIRECT_URI,
            state: 'platform=leadperfection&hostname=pilot.leadperfection.com',
            hostname: 'pilot.leadperfection.com'
        });
        const result = await request(fetchFn, `${baseUrl}/leadperfection/auth?${params}`, timeoutMs);
        assert(result.status === 200, `Expected HTTP 200, received ${result.status}.`);
        assert(result.body.includes('<title>LeadPerfection Sign In</title>'), 'The expected sign-in page was not returned.');
        assert(result.body.includes('name="username"') && result.body.includes('name="password"'),
            'The sign-in form is missing username or password inputs.');
        return { httpStatus: result.status, responseMs: result.durationMs };
    });

    await check('Sign-in page hardening', async () => {
        const foreignRedirect = new URLSearchParams({
            redirect_uri: 'https://smoke-test.invalid/collect',
            state: 'platform=leadperfection'
        });
        const rejected = await request(fetchFn, `${baseUrl}/leadperfection/auth?${foreignRedirect}`, timeoutMs);
        assert(rejected.status === 400,
            `A foreign redirect_uri must be rejected with HTTP 400, received ${rejected.status}.`);

        const markup = new URLSearchParams({
            redirect_uri: APP_CONNECT_REDIRECT_URI,
            state: 'platform=leadperfection',
            hostname: '"><b id=smoke-marker>'
        });
        const escaped = await request(fetchFn, `${baseUrl}/leadperfection/auth?${markup}`, timeoutMs);
        assert(escaped.status === 200, `Expected HTTP 200, received ${escaped.status}.`);
        assert(!escaped.body.includes('<b id=smoke-marker>'), 'The sign-in page reflects request values without escaping.');
        return { foreignRedirectStatus: rejected.status };
    });

    if (options.consoleManifestUrl) {
        // The extension downloads its manifest from the App Connect Developer
        // Console, not from this server, so its routing must be checked there.
        await check('Developer Console manifest routing', async () => {
            const result = await request(fetchFn, options.consoleManifestUrl, timeoutMs);
            assert(result.status === 200, `Expected HTTP 200, received ${result.status}.`);
            const consoleManifest = parseJson(result.body, 'The Developer Console manifest');
            const platform = consoleManifest.auth
                ? consoleManifest
                : Object.values(consoleManifest.platforms || {})[0] || {};
            const serverUrl = consoleManifest.serverUrl;
            const authUrl = platform.auth?.oauth?.authUrl;
            assert(serverUrl === baseUrl,
                `Console serverUrl is ${JSON.stringify(serverUrl)} instead of ${JSON.stringify(baseUrl)}.`);
            assert(authUrl === `${baseUrl}/leadperfection/auth`,
                `Console authUrl is ${JSON.stringify(authUrl)} instead of the hosted sign-in page.`);
            return { serverUrl, authUrl, version: consoleManifest.version };
        });
    }

    return {
        baseUrl,
        checkedAt: new Date().toISOString(),
        passed: checks.every(item => item.status === 'passed'),
        checks
    };
}

function printReport(report) {
    console.log(`Hosted smoke test: ${report.baseUrl}`);
    console.log(`Checked: ${report.checkedAt}`);
    for (const item of report.checks) {
        const marker = item.status === 'passed' ? 'PASS' : 'FAIL';
        const suffix = item.error ? ` - ${item.error}` : '';
        console.log(`[${marker}] ${item.name} (${item.durationMs} ms)${suffix}`);
    }
    console.log(report.passed ? 'Hosted smoke test passed.' : 'Hosted smoke test failed.');
}

async function main() {
    // pnpm forwards a literal `--` separator to the script; ignore it.
    const args = process.argv.slice(2).filter(arg => arg !== '--');
    const baseUrl = args[0] || process.env.HOSTED_APP_URL;
    const consoleManifestUrl = args[1] || process.env.CONSOLE_MANIFEST_URL;
    try {
        const report = await runHostedSmoke(baseUrl, { consoleManifestUrl });
        printReport(report);
        process.exitCode = report.passed ? 0 : 1;
    }
    catch (error) {
        console.error(`Hosted smoke test could not start: ${error.message}`);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    normalizeBaseUrl,
    runHostedSmoke
};
