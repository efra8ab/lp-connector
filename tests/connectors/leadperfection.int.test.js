/* eslint-disable no-undef */
const nock = require('nock');
const leadperfection = require('../../src/connectors/leadperfection');
const { encode, decoded } = require('@app-connect/core/lib/encode');
const { createMockUser, createMockCallLog } = require('../fixtures/connectorMocks');

jest.mock('@app-connect/core/models/userModel', () => ({
    UserModel: {
        findByPk: jest.fn()
    }
}));

jest.mock('@app-connect/core/models/dynamo/lockSchema', () => ({
    Lock: {
        create: jest.fn(),
        get: jest.fn()
    }
}));

const { Lock } = require('@app-connect/core/models/dynamo/lockSchema');

describe('LeadPerfection Connector', () => {
    const baseUrl = 'https://apitest.leadperfection.com';
    const tokenUrl = `${baseUrl}/token`;
    let mockUser;

    beforeEach(() => {
        nock.cleanAll();
        jest.clearAllMocks();
        process.env.APP_SERVER_SECRET_KEY = 'test-secret-key-32-bytes-long!!!';
        process.env.LP_BASE_URL = baseUrl;
        process.env.LP_CLIENT_ID = 'demo3';
        process.env.LP_APPKEY = 'test-app-key';

        mockUser = createMockUser({
            id: '77-leadperfection',
            hostname: 'demo3.leadperfection.com',
            platform: 'leadperfection',
            accessToken: 'current-access-token',
            refreshToken: 'refresh-token',
            tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
            platformAdditionalInfo: {
                apiUrl: baseUrl,
                tokenUrl,
                clientId: 'demo3',
                employeeId: 77,
                encodedApiUsername: encode('demo3api'),
                encodedApiPassword: encode('LP3api123!'),
                permissions: ['GetCustomers3', 'AddCallHistory']
            }
        });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    test('getAuthType returns oauth', () => {
        expect(leadperfection.getAuthType()).toBe('oauth');
    });

    test('getOauthInfo returns LP token configuration', async () => {
        const result = await leadperfection.getOauthInfo({ tokenUrl });
        expect(result.accessTokenUri).toBe(tokenUrl);
        expect(result.clientId).toBe('demo3');
        expect(result.clientSecret).toBe('test-app-key');
    });

    test('getOverridingOAuthOption decodes the opaque auth code', () => {
        const code = encode(JSON.stringify({
            username: 'demo3api',
            password: 'LP3api123!',
            clientId: 'demo3'
        }));
        const result = leadperfection.getOverridingOAuthOption({ code });
        expect(result.query.grant_type).toBe('password');
        expect(result.query.username).toBe('demo3api');
        expect(result.query.password).toBe('LP3api123!');
        expect(result.query.clientid).toBe('demo3');
        expect(result.query.appkey).toBe('test-app-key');
    });

    test('getUserInfo parses token response and stores encrypted credentials', async () => {
        const code = encode(JSON.stringify({
            username: 'demo3api',
            password: 'LP3api123!',
            clientId: 'demo3'
        }));
        const result = await leadperfection.getUserInfo({
            tokenUrl,
            hostname: 'demo3.leadperfection.com',
            callbackUri: `https://example.com/callback?code=${code}`,
            data: {
                user_data: {
                    Settings: ['GetCustomers3', 'AddCallHistory'],
                    EmpID: 77,
                    Name: 'Demo User'
                }
            }
        });
        expect(result.successful).toBe(true);
        expect(result.platformUserInfo.id).toBe('77-leadperfection');
        expect(result.platformUserInfo.name).toBe('Demo User');
        expect(result.platformUserInfo.platformAdditionalInfo.permissions).toEqual(['GetCustomers3', 'AddCallHistory']);
        expect(decoded(result.platformUserInfo.platformAdditionalInfo.encodedApiUsername)).toBe('demo3api');
        expect(decoded(result.platformUserInfo.platformAdditionalInfo.encodedApiPassword)).toBe('LP3api123!');
    });

    test('exchangeOAuthCallback exchanges the opaque code with LP password grant', async () => {
        const code = encode(JSON.stringify({
            username: 'demo3api',
            password: 'LP3api123!',
            clientId: 'demo3'
        }));
        nock(baseUrl)
            .post('/token')
            .reply(200, {
                access_token: 'token-123',
                refresh_token: 'refresh-123',
                expires_in: 86400,
                user_data: {
                    Settings: ['GetCustomers3']
                }
            });

        const result = await leadperfection.exchangeOAuthCallback({
            callbackUri: `https://example.com/callback?code=${code}`,
            tokenUrl,
            hostname: 'demo3.leadperfection.com'
        });

        expect(result.accessToken).toBe('token-123');
        expect(result.refreshToken).toBe('refresh-123');
        expect(result.data.user_data.Settings).toEqual(['GetCustomers3']);
    });

    test('checkAndRefreshAccessToken refreshes an expired token', async () => {
        mockUser.tokenExpiry = new Date(Date.now() - 60 * 1000);
        const deleteMock = jest.fn().mockResolvedValue(true);
        Lock.create.mockResolvedValue({ delete: deleteMock });

        nock(baseUrl)
            .post('/token')
            .reply(200, {
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
                expires_in: 86400
            });

        const result = await leadperfection.checkAndRefreshAccessToken({}, mockUser);

        expect(result.accessToken).toBe('new-access-token');
        expect(result.refreshToken).toBe('new-refresh-token');
        expect(mockUser.save).toHaveBeenCalled();
        expect(deleteMock).toHaveBeenCalled();
    });

    test('authValidation succeeds with a no-op GetCustomers3 request', async () => {
        nock(baseUrl)
            .post('/api/Customers/GetCustomers3')
            .reply(200, []);

        const result = await leadperfection.authValidation({ user: mockUser });

        expect(result.successful).toBe(true);
        expect(result.status).toBe(200);
    });

    test('findContact normalizes LP matches', async () => {
        nock(baseUrl)
            .post('/api/Customers/GetCustomers3')
            .reply(200, [
                {
                    CustID: 123,
                    FirstName: 'Jane',
                    LastName: 'Smith',
                    Phone: '+14155551234'
                }
            ]);

        const result = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155551234',
            isExtension: 'false'
        });

        expect(result.successful).toBe(true);
        expect(result.matchedContactInfo).toHaveLength(1);
        expect(result.matchedContactInfo[0]).toMatchObject({
            id: '123',
            name: 'Jane Smith',
            type: 'Contact'
        });
    });

    test('findContact accepts a single-object GetCustomers3 response', async () => {
        nock(baseUrl)
            .post('/api/Customers/GetCustomers3')
            .reply(200, {
                CustID: 124,
                FirstName: 'Solo',
                LastName: 'Match',
                Phone: '+14155550011'
            });

        const result = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155550011',
            isExtension: 'false'
        });

        expect(result.successful).toBe(true);
        expect(result.matchedContactInfo).toHaveLength(1);
        expect(result.matchedContactInfo[0]).toMatchObject({
            id: '124',
            name: 'Solo Match',
            type: 'Contact'
        });
    });

    test('findContact tries NANP country-code variants for local 10-digit numbers', async () => {
        nock(baseUrl)
            .post('/api/Customers/GetCustomers3', body => body.phone === '4155550002')
            .reply(200, [])
            .post('/api/Customers/GetCustomers3', body => body.phone === '14155550002')
            .reply(200, [
                {
                    CustID: 125,
                    FirstName: 'Local',
                    LastName: 'Format',
                    Phone: '14155550002'
                }
            ]);

        const result = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '4155550002',
            isExtension: 'false'
        });

        expect(result.successful).toBe(true);
        expect(result.matchedContactInfo).toHaveLength(1);
        expect(result.matchedContactInfo[0]).toMatchObject({
            id: '125',
            name: 'Local Format',
            type: 'Contact'
        });
    });

    test('findContact reuses a cached result for repeated lookups', async () => {
        const scope = nock(baseUrl)
            .post('/api/Customers/GetCustomers3')
            .once()
            .reply(200, [
                {
                    CustID: 222,
                    FirstName: 'Cached',
                    LastName: 'Contact',
                    Phone: '+14155557654'
                }
            ]);

        const firstResult = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155557654',
            isExtension: 'false'
        });
        const secondResult = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155557654',
            isExtension: 'false'
        });

        expect(scope.isDone()).toBe(true);
        expect(firstResult.matchedContactInfo[0].id).toBe('222');
        expect(secondResult.matchedContactInfo[0].id).toBe('222');
    });

    test('findContact returns an empty result during LP rate-limit cooldown', async () => {
        const scope = nock(baseUrl)
            .post('/api/Customers/GetCustomers3')
            .once()
            .reply(429, {
                error: 'Too Many Requests',
                message: 'Rate limit exceeded. Maximum 100 requests per 60 seconds.',
                retryAfterSeconds: 30
            });

        const firstResult = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155550000',
            isExtension: 'false'
        });
        const secondResult = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155550001',
            isExtension: 'false'
        });

        expect(scope.isDone()).toBe(true);
        expect(firstResult).toEqual({
            successful: true,
            matchedContactInfo: []
        });
        expect(secondResult).toEqual({
            successful: true,
            matchedContactInfo: []
        });
    });

    test('createContact posts LeadAdd payload', async () => {
        nock(baseUrl)
            .post('/api/Leads/LeadAdd', body => body.firstname === 'Jane' && body.lastname === 'Smith' && body.phone === '+14155551234')
            .reply(200, { prospectid: 456 });

        const result = await leadperfection.createContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155551234',
            newContactName: 'Jane Smith'
        });

        expect(result.contactInfo.id).toBe('456');
        expect(result.contactInfo.type).toBe('Lead');
    });

    test('createCallLog posts AddCallHistory payload', async () => {
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => (
                body.CustID === '123'
                && body.EmpID === 77
                && body.CallType === 'Outbound'
                && body.Duration === '00:05:00'
                && body.RecordingURL === 'https://recording.example.com/123'
            ))
            .reply(200, { CallHistoryID: 999 });

        const result = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo: {
                id: '123',
                name: 'John Doe',
                phone: '+14155551234',
                type: 'Contact',
                additionalInfo: {
                    custId: '123'
                }
            },
            callLog,
            additionalSubmission: null
        });

        expect(result.logId).toBe(999);
        expect(result.returnMessage.message).toBe('Call logged');
    });
});
