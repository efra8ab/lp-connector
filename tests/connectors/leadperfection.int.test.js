/* eslint-disable no-undef */
const nock = require('nock');
const leadperfection = require('../../src/connectors/leadperfection');
const { encode, decoded } = require('@app-connect/core/lib/encode');
const logger = require('@app-connect/core/lib/logger');
const { createMockUser, createMockCallLog } = require('../fixtures/connectorMocks');

jest.mock('@app-connect/core/models/userModel', () => ({
    UserModel: {
        findByPk: jest.fn()
    }
}));

jest.mock('@app-connect/core/models/tokenRefreshLockModel', () => ({
    acquireTokenRefreshLock: jest.fn(),
    getTokenRefreshLock: jest.fn(),
    releaseTokenRefreshLock: jest.fn()
}));

const {
    acquireTokenRefreshLock,
    getTokenRefreshLock,
    releaseTokenRefreshLock
} = require('@app-connect/core/models/tokenRefreshLockModel');

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
        acquireTokenRefreshLock.mockResolvedValue(true);
        getTokenRefreshLock.mockResolvedValue(null);
        releaseTokenRefreshLock.mockResolvedValue(1);

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

    test('getUserInfo captures the employee from the production Emp_ID field', async () => {
        const code = encode(JSON.stringify({
            username: 'aflores',
            password: 'secret',
            clientId: 'v6nka'
        }));
        const result = await leadperfection.getUserInfo({
            hostname: 'v6nka.leadperfection.com',
            callbackUri: `https://example.com/callback?code=${code}`,
            data: {
                user_data: {
                    Settings: ['GetCustomers3', 'AddCallHistory'],
                    Emp_ID: 64
                }
            }
        });

        expect(result.successful).toBe(true);
        expect(result.platformUserInfo.id).toBe('aflores-leadperfection');
        expect(result.platformUserInfo.platformAdditionalInfo.employeeId).toBe(64);
    });

    test('exchangeOAuthCallback ignores a caller-supplied token URL', async () => {
        const code = encode(JSON.stringify({
            username: 'demo3api',
            password: 'LP3api123!',
            clientId: 'demo3'
        }));
        const attackerScope = nock('https://attacker.example')
            .post('/token')
            .reply(200, { access_token: 'attacker-token' });
        nock(baseUrl)
            .post('/token', body => body.appkey === 'test-app-key')
            .reply(200, {
                access_token: 'token-123',
                refresh_token: 'refresh-123',
                expires_in: 86400
            });

        const result = await leadperfection.exchangeOAuthCallback({
            callbackUri: `https://example.com/callback?code=${code}`,
            tokenUrl: 'https://attacker.example/token',
            hostname: 'demo3.leadperfection.com'
        });

        expect(result.accessToken).toBe('token-123');
        expect(attackerScope.isDone()).toBe(false);
    });

    test('token refresh ignores a token URL stored on the user', async () => {
        mockUser.tokenExpiry = new Date(Date.now() - 60 * 1000);
        mockUser.platformAdditionalInfo.tokenUrl = 'https://attacker.example/token';
        const attackerScope = nock('https://attacker.example')
            .post('/token')
            .reply(200, { access_token: 'attacker-token' });
        nock(baseUrl)
            .post('/token')
            .reply(200, {
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
                expires_in: 86400
            });

        const result = await leadperfection.checkAndRefreshAccessToken({}, mockUser);

        expect(result.accessToken).toBe('new-access-token');
        expect(attackerScope.isDone()).toBe(false);
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
        expect(releaseTokenRefreshLock).toHaveBeenCalledWith({
            userId: mockUser.id,
            ownerId: expect.any(String)
        });
    });

    test('simultaneous refresh attempts perform only one token request', async () => {
        mockUser.tokenExpiry = new Date(Date.now() - 60 * 1000);
        let released = false;
        acquireTokenRefreshLock
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        getTokenRefreshLock.mockImplementation(async () => (
            released ? null : { expiresAt: Date.now() + 30000 }
        ));
        releaseTokenRefreshLock.mockImplementation(async () => {
            released = true;
            return 1;
        });
        const findByPk = require('@app-connect/core/models/userModel').UserModel.findByPk;
        findByPk.mockImplementation(async () => mockUser);

        const tokenScope = nock(baseUrl)
            .post('/token')
            .once()
            .delay(25)
            .reply(200, {
                access_token: 'one-shared-access-token',
                refresh_token: 'one-shared-refresh-token',
                expires_in: 86400
            });

        const [firstResult, secondResult] = await Promise.all([
            leadperfection.checkAndRefreshAccessToken({}, mockUser),
            leadperfection.checkAndRefreshAccessToken({}, mockUser)
        ]);

        expect(tokenScope.isDone()).toBe(true);
        expect(firstResult.accessToken).toBe('one-shared-access-token');
        expect(secondResult.accessToken).toBe('one-shared-access-token');
        expect(mockUser.save).toHaveBeenCalledTimes(1);
    });

    test('takes over an expired token lock atomically', async () => {
        mockUser.tokenExpiry = new Date(Date.now() - 60 * 1000);
        acquireTokenRefreshLock
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        getTokenRefreshLock.mockResolvedValue({
            expiresAt: Date.now() - 1000
        });

        nock(baseUrl)
            .post('/token')
            .once()
            .reply(200, {
                access_token: 'takeover-access-token',
                refresh_token: 'takeover-refresh-token',
                expires_in: 86400
            });

        const result = await leadperfection.checkAndRefreshAccessToken({}, mockUser);

        expect(result.accessToken).toBe('takeover-access-token');
        expect(acquireTokenRefreshLock).toHaveBeenCalledTimes(2);
        expect(releaseTokenRefreshLock).toHaveBeenCalledTimes(1);
    });

    test('times out while another request keeps an active token lock', async () => {
        mockUser.tokenExpiry = new Date(Date.now() - 60 * 1000);
        acquireTokenRefreshLock.mockResolvedValue(false);
        getTokenRefreshLock.mockResolvedValue({
            expiresAt: Date.now() + 30000
        });

        await expect(
            leadperfection.checkAndRefreshAccessToken({}, mockUser, 0.01)
        ).rejects.toThrow('LeadPerfection token lock timeout');

        expect(releaseTokenRefreshLock).not.toHaveBeenCalled();
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

    test('findContact attaches call-log dropdown options to matched contacts', async () => {
        nock(baseUrl)
            .post('/api/Customers/GetCustomers3')
            .reply(200, [
                {
                    CustID: 321,
                    FirstName: 'Drop',
                    LastName: 'Downs',
                    Phone: '+14155559901'
                }
            ]);

        const result = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155559901',
            isExtension: 'false'
        });

        const additionalInfo = result.matchedContactInfo[0].additionalInfo;
        expect(additionalInfo.resultCode).toHaveLength(19);
        expect(additionalInfo.resultCode[0]).toEqual({ const: 'NA', title: 'No Answer' });
        expect(additionalInfo.callType).toHaveLength(12);
        expect(additionalInfo.callType[0].const).toBe('auto');
        expect(additionalInfo.callType[1]).toEqual({ const: 'O', title: 'Other' });
    });

    test('findContact attaches dropdown options to the create-new-contact entry', async () => {
        process.env.LP_ENABLE_LEAD_ADD = 'true';
        nock(baseUrl)
            .post('/api/Customers/GetCustomers3')
            .times(10)
            .reply(200, []);

        const result = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155559902',
            isExtension: 'false'
        });

        expect(result.matchedContactInfo).toHaveLength(1);
        const newContactEntry = result.matchedContactInfo[0];
        expect(newContactEntry.isNewContact).toBe(true);
        expect(newContactEntry.additionalInfo.resultCode).toHaveLength(19);
        expect(newContactEntry.additionalInfo.callType).toHaveLength(12);

        delete process.env.LP_ENABLE_LEAD_ADD;
    });

    test('findContact offers no create-new-contact entry while LeadAdd is not enabled', async () => {
        nock(baseUrl)
            .post('/api/Customers/GetCustomers3')
            .times(10)
            .reply(200, []);

        const result = await leadperfection.findContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155559903',
            isExtension: 'false'
        });

        expect(result.successful).toBe(true);
        expect(result.matchedContactInfo).toEqual([]);
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
        process.env.LP_ENABLE_LEAD_ADD = 'true';
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

        delete process.env.LP_ENABLE_LEAD_ADD;
    });

    test('createContact explains that contact creation is disabled without calling LeadAdd', async () => {
        const result = await leadperfection.createContact({
            user: mockUser,
            authHeader: 'Bearer current-access-token',
            phoneNumber: '+14155551234',
            newContactName: 'Jane Smith'
        });

        expect(result.contactInfo).toBeNull();
        expect(result.returnMessage.messageType).toBe('warning');
        expect(result.returnMessage.message).toMatch(/Add the lead in LeadPerfection first/);
        expect(nock.pendingMocks()).toEqual([]);
    });

    test('createCallLog posts AddCallHistory payload', async () => {
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => (
                body.CustID === '123'
                && body.EmpID === 77
                && body.CallType === 'O'
                && body.ResultCode === 'NA'
                && body.Phone === '14155555678'
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

    test('createCallLog uses env employee and call defaults when LP user data is missing them', async () => {
        const callLog = createMockCallLog();
        const userWithoutEmployee = createMockUser({
            ...mockUser,
            platformAdditionalInfo: {
                ...mockUser.platformAdditionalInfo,
                employeeId: null
            }
        });
        process.env.LP_EMPLOYEE_ID = '51';
        process.env.LP_DEFAULT_CALL_TYPE = 'D';
        process.env.LP_DEFAULT_RESULT_CODE = 'WN';

        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => (
                body.CustID === '123'
                && body.EmpID === '51'
                && body.CallType === 'D'
                && body.ResultCode === 'WN'
            ))
            .reply(200, { CallHistoryID: 1001 });

        const result = await leadperfection.createCallLog({
            user: userWithoutEmployee,
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

        expect(result.logId).toBe(1001);

        delete process.env.LP_EMPLOYEE_ID;
        delete process.env.LP_DEFAULT_CALL_TYPE;
        delete process.env.LP_DEFAULT_RESULT_CODE;
    });

    test('createCallLog uses agent-selected call result and call type from additionalSubmission', async () => {
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => (
                body.CustID === '123'
                && body.CallType === 'V'
                && body.ResultCode === 'LM'
            ))
            .reply(200, { CallHistoryID: 1002 });

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
            additionalSubmission: {
                resultCode: 'LM',
                callType: 'V'
            }
        });

        expect(result.logId).toBe(1002);
    });

    test('createCallLog treats a "none" dropdown selection as unset', async () => {
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => (
                body.CustID === '123'
                && body.CallType === 'O'
                && body.ResultCode === 'NA'
            ))
            .reply(200, { CallHistoryID: 1005 });

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
            additionalSubmission: {
                resultCode: 'none',
                callType: 'none'
            }
        });

        expect(result.logId).toBe(1005);
    });

    test('createCallLog defaults inbound calls to the inbound call type', async () => {
        const callLog = createMockCallLog({ direction: 'Inbound' });
        process.env.LP_INBOUND_CALL_TYPE = 'I';

        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => (
                body.CustID === '123'
                && body.CallType === 'I'
                && body.Phone === '14155551234'
            ))
            .reply(200, { CallHistoryID: 1003 });

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

        expect(result.logId).toBe(1003);

        delete process.env.LP_INBOUND_CALL_TYPE;
    });

    test('createCallLog saves the agent note to the LP Notes tab via AddNotes', async () => {
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory')
            .reply(200, { CallHistoryID: 1006 })
            .post('/api/SalesApi/AddNotes', body => (
                body.rectype === 'cst'
                && body.recid === '3685357'
                && body.notes === 'Left a voicemail'
            ))
            .reply(200, '"UPDATED SUCCESSFULLY!"');

        const result = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo: {
                id: '3685357',
                name: 'Test Test',
                phone: '+14155551234',
                type: 'Lead',
                additionalInfo: {
                    custId: null,
                    leadId: '3685357',
                    prospectId: '3685357'
                }
            },
            callLog,
            note: 'Left a voicemail',
            additionalSubmission: null
        });

        expect(result.logId).toBe(1006);
        expect(result.returnMessage.messageType).toBe('success');
        expect(result.returnMessage.message).toMatch(/note saved/i);
    });

    test('createCallLog still returns the logId when AddNotes fails', async () => {
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory')
            .reply(200, { CallHistoryID: 1007 })
            .post('/api/SalesApi/AddNotes')
            .reply(500, 'server error');

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
            note: 'A note that will not stick',
            additionalSubmission: null
        });

        expect(result.logId).toBe(1007);
        expect(result.returnMessage.messageType).toBe('warning');
        expect(result.returnMessage.message).toMatch(/note could not be saved/i);
    });

    describe('AI Assistant notes', () => {
        const leadContact = {
            id: '5550001',
            name: 'Ai Test',
            phone: '+14155551234',
            type: 'Lead',
            additionalInfo: {
                custId: null,
                leadId: '5550001',
                prospectId: '3027945'
            }
        };
        const aiNote = '**Summary**\nCustomer wants a quote for a walk-in tub.\n\n**Tasks**\n- Call back Friday';
        const aiNoteText = 'Summary\nCustomer wants a quote for a walk-in tub.\n\nTasks\n- Call back Friday';

        test('createCallLog saves the AI note below the agent note', async () => {
            nock(baseUrl)
                .post('/api/Customers/AddCallHistory')
                .reply(200, { CallHistoryID: 2001 })
                .post('/api/SalesApi/AddNotes', body => (
                    body.recid === '3027945'
                    && body.notes === `Left a voicemail\n\nAI Note:\n${aiNoteText}`
                ))
                .reply(200, '"UPDATED SUCCESSFULLY!"');

            const result = await leadperfection.createCallLog({
                user: mockUser,
                contactInfo: leadContact,
                callLog: createMockCallLog({ sessionId: 'ai-create-both' }),
                note: 'Left a voicemail',
                aiNote,
                additionalSubmission: null
            });

            expect(result.logId).toBe(2001);
            expect(result.returnMessage.message).toMatch(/note saved/i);
            expect(nock.isDone()).toBe(true);
        });

        test('createCallLog saves the AI note alone when the agent typed no note', async () => {
            nock(baseUrl)
                .post('/api/Customers/AddCallHistory')
                .reply(200, { CallHistoryID: 2002 })
                .post('/api/SalesApi/AddNotes', body => body.notes === `AI Note:\n${aiNoteText}`)
                .reply(200, '"UPDATED SUCCESSFULLY!"');

            const result = await leadperfection.createCallLog({
                user: mockUser,
                contactInfo: leadContact,
                callLog: createMockCallLog({ sessionId: 'ai-create-only' }),
                note: '',
                aiNote,
                additionalSubmission: null
            });

            expect(result.returnMessage.message).toMatch(/note saved/i);
            expect(nock.isDone()).toBe(true);
        });

        test('createCallLog leaves out the AI note when the agent turned off AI note logging', async () => {
            nock(baseUrl)
                .post('/api/Customers/AddCallHistory')
                .reply(200, { CallHistoryID: 2003 })
                .post('/api/SalesApi/AddNotes', body => body.notes === 'Left a voicemail')
                .reply(200, '"UPDATED SUCCESSFULLY!"');

            await leadperfection.createCallLog({
                user: { ...mockUser, userSettings: { addCallLogAiNote: { value: false } } },
                contactInfo: leadContact,
                callLog: createMockCallLog({ sessionId: 'ai-create-off' }),
                note: 'Left a voicemail',
                aiNote,
                additionalSubmission: null
            });

            expect(nock.isDone()).toBe(true);
        });

        test('updateCallLog adds a late AI note to the record that got the call note', async () => {
            nock(baseUrl)
                .post('/api/Customers/AddCallHistory')
                .reply(200, { CallHistoryID: 2004 })
                .post('/api/SalesApi/AddNotes', body => body.notes === 'Left a voicemail')
                .reply(200, '"UPDATED SUCCESSFULLY!"')
                .post('/api/SalesApi/AddNotes', body => (
                    body.recid === '3027945'
                    && body.notes === `AI Note:\n${aiNoteText}`
                ))
                .reply(200, '"UPDATED SUCCESSFULLY!"');

            await leadperfection.createCallLog({
                user: mockUser,
                contactInfo: leadContact,
                callLog: createMockCallLog({ sessionId: 'ai-late' }),
                note: 'Left a voicemail',
                additionalSubmission: null
            });
            const result = await leadperfection.updateCallLog({
                user: mockUser,
                existingCallLog: { sessionId: 'ai-late', contactId: leadContact.id, thirdPartyLogId: '2004' },
                aiNote
            });

            expect(result.returnMessage.messageType).toBe('success');
            expect(result.returnMessage.message).toMatch(/AI note saved/i);
            expect(nock.isDone()).toBe(true);
        });

        test('updateCallLog does not repeat an AI note that was already saved', async () => {
            nock(baseUrl)
                .post('/api/Customers/AddCallHistory')
                .reply(200, { CallHistoryID: 2005 })
                .post('/api/SalesApi/AddNotes')
                .reply(200, '"UPDATED SUCCESSFULLY!"');

            await leadperfection.createCallLog({
                user: mockUser,
                contactInfo: leadContact,
                callLog: createMockCallLog({ sessionId: 'ai-repeat' }),
                note: '',
                aiNote,
                additionalSubmission: null
            });
            const result = await leadperfection.updateCallLog({
                user: mockUser,
                existingCallLog: { sessionId: 'ai-repeat', contactId: leadContact.id, thirdPartyLogId: '2005' },
                aiNote
            });

            expect(result.returnMessage.message).toMatch(/not implemented/i);
            expect(nock.pendingMocks()).toEqual([]);
        });

        test('updateCallLog adds an edited AI note as a new note', async () => {
            nock(baseUrl)
                .post('/api/Customers/AddCallHistory')
                .reply(200, { CallHistoryID: 2006 })
                .post('/api/SalesApi/AddNotes')
                .reply(200, '"UPDATED SUCCESSFULLY!"')
                .post('/api/SalesApi/AddNotes', body => (
                    body.recid === '3027945'
                    && body.notes === 'AI Note (edited):\nCustomer wants a quote. Call back Monday.'
                ))
                .reply(200, '"UPDATED SUCCESSFULLY!"');

            await leadperfection.createCallLog({
                user: mockUser,
                contactInfo: leadContact,
                callLog: createMockCallLog({ sessionId: 'ai-edited' }),
                note: '',
                aiNote,
                additionalSubmission: null
            });
            const result = await leadperfection.updateCallLog({
                user: mockUser,
                existingCallLog: { sessionId: 'ai-edited', contactId: leadContact.id, thirdPartyLogId: '2006' },
                aiNote: 'Customer wants a quote. Call back Monday.'
            });

            expect(result.returnMessage.messageType).toBe('success');
            expect(nock.isDone()).toBe(true);
        });

        test('updateCallLog falls back to the logged contact when no note record was remembered', async () => {
            nock(baseUrl)
                .post('/api/SalesApi/AddNotes', body => (
                    body.recid === '5550001'
                    && body.notes === `AI Note:\n${aiNoteText}`
                ))
                .reply(200, '"UPDATED SUCCESSFULLY!"');

            const result = await leadperfection.updateCallLog({
                user: mockUser,
                existingCallLog: { sessionId: 'ai-no-cache', contactId: '5550001', thirdPartyLogId: '2007' },
                aiNote
            });

            expect(result.returnMessage.messageType).toBe('success');
            expect(nock.isDone()).toBe(true);
        });

        test('updateCallLog warns when LeadPerfection rejects the AI note', async () => {
            nock(baseUrl)
                .post('/api/SalesApi/AddNotes')
                .reply(500, 'server error');

            const result = await leadperfection.updateCallLog({
                user: mockUser,
                existingCallLog: { sessionId: 'ai-rejected', contactId: '5550001', thirdPartyLogId: '2008' },
                aiNote
            });

            expect(result.returnMessage.messageType).toBe('warning');
            expect(result.returnMessage.message).toMatch(/AI note could not be saved/i);
        });

        test('updateCallLog without an AI note still explains that edits are not saved', async () => {
            const result = await leadperfection.updateCallLog({
                user: mockUser,
                existingCallLog: { sessionId: 'ai-none', contactId: '5550001', thirdPartyLogId: '2009' },
                note: 'Edited typed note'
            });

            expect(result.returnMessage.messageType).toBe('warning');
            expect(result.returnMessage.message).toMatch(/not implemented/i);
        });
    });

    test('createCallLog returns warning when LeadPerfection reports body-level failure', async () => {
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory')
            .reply(200, [
                {
                    Result: 0,
                    Message: 'Error: CallType does not exist.'
                }
            ]);

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

        expect(result.logId).toBeNull();
        expect(result.returnMessage.message).toBe('Error: CallType does not exist.');
        expect(result.returnMessage.messageType).toBe('warning');
    });

    test('createCallLog posts ProspectID for Lead matches', async () => {
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => (
                body.ProspectID === '5220526'
                && body.CustID === undefined
                && body.EmpID === 77
            ))
            .reply(200, { CallHistoryID: 1000 });

        const result = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo: {
                id: '5220526',
                name: 'Della Smith',
                phone: '(720)236-7458',
                type: 'Lead',
                additionalInfo: {
                    leadId: '5220526',
                    prospectId: '5220526',
                    custId: null
                }
            },
            callLog,
            additionalSubmission: null
        });

        expect(result.logId).toBe(1000);
        expect(result.returnMessage.message).toBe('Call logged');
    });

    const contactInfo = {
        id: '123',
        name: 'John Doe',
        phone: '+14155551234',
        type: 'Contact',
        additionalInfo: {
            custId: '123'
        }
    };

    test('createCallLog formats CallDate in the LeadPerfection business timezone', async () => {
        // 10:00 UTC on January 15 is 03:00 Mountain Standard Time.
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => body.CallDate === '2024-01-15 03:00:00')
            .reply(200, { CallHistoryID: 1010 });

        const result = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo,
            callLog,
            additionalSubmission: null
        });

        expect(result.logId).toBe(1010);
    });

    test('createCallLog honors an LP_TIMEZONE override', async () => {
        process.env.LP_TIMEZONE = 'America/New_York';
        const callLog = createMockCallLog();
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => body.CallDate === '2024-01-15 05:00:00')
            .reply(200, { CallHistoryID: 1011 });

        const result = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo,
            callLog,
            additionalSubmission: null
        });

        expect(result.logId).toBe(1011);

        delete process.env.LP_TIMEZONE;
    });

    test('createCallLog resolves the Auto call type from the call direction', async () => {
        process.env.LP_INBOUND_CALL_TYPE = 'I';
        process.env.LP_OUTBOUND_CALL_TYPE = 'O';
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => body.CallType === 'I')
            .reply(200, { CallHistoryID: 1012 })
            .post('/api/Customers/AddCallHistory', body => body.CallType === 'O')
            .reply(200, { CallHistoryID: 1013 });

        const inbound = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo,
            callLog: createMockCallLog({ direction: 'Inbound', sessionId: 'session-auto-in' }),
            additionalSubmission: { resultCode: 'NA', callType: 'auto' }
        });
        const outbound = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo,
            callLog: createMockCallLog({ direction: 'Outbound', sessionId: 'session-auto-out' }),
            additionalSubmission: { resultCode: 'NA', callType: 'auto' }
        });

        expect(inbound.logId).toBe(1012);
        expect(outbound.logId).toBe(1013);

        delete process.env.LP_INBOUND_CALL_TYPE;
        delete process.env.LP_OUTBOUND_CALL_TYPE;
    });

    test('createCallLog retries under LP_EMPLOYEE_ID when LP rejects the agent employee', async () => {
        process.env.LP_EMPLOYEE_ID = '51';
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory', body => body.EmpID === 77)
            .reply(200, [{ Result: 0, Message: 'Error: Employee id does not exist.' }])
            .post('/api/Customers/AddCallHistory', body => body.EmpID === '51')
            .reply(200, { CallHistoryID: 1014 });

        const result = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo,
            callLog: createMockCallLog(),
            additionalSubmission: null
        });

        expect(result.logId).toBe(1014);
        expect(result.returnMessage.messageType).toBe('success');
        expect(nock.pendingMocks()).toEqual([]);

        delete process.env.LP_EMPLOYEE_ID;
    });

    test('createCallLog does not retry other LeadPerfection validation errors', async () => {
        process.env.LP_EMPLOYEE_ID = '51';
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory')
            .once()
            .reply(200, [{ Result: 0, Message: 'Error: CallType does not exist.' }]);

        const result = await leadperfection.createCallLog({
            user: mockUser,
            contactInfo,
            callLog: createMockCallLog(),
            additionalSubmission: null
        });

        expect(result.logId).toBeNull();
        expect(result.returnMessage.message).toBe('Error: CallType does not exist.');

        delete process.env.LP_EMPLOYEE_ID;
    });

    test('createCallLog keeps customer phone numbers and LP responses out of production logs', async () => {
        const originalIsProd = process.env.IS_PROD;
        process.env.IS_PROD = 'true';
        const infoSpy = jest.spyOn(logger, 'info');
        nock(baseUrl)
            .post('/api/Customers/AddCallHistory')
            .reply(200, { CallHistoryID: 1015 })
            .post('/api/SalesApi/AddNotes')
            .reply(200, 'UPDATED SUCCESSFULLY!');

        await leadperfection.createCallLog({
            user: mockUser,
            contactInfo,
            callLog: createMockCallLog(),
            note: 'Customer asked for a callback',
            additionalSubmission: null
        });

        const logged = JSON.stringify(infoSpy.mock.calls);
        expect(logged).not.toContain('14155555678');
        expect(logged).not.toContain('UPDATED SUCCESSFULLY');
        expect(logged).not.toContain('Customer asked for a callback');

        infoSpy.mockRestore();
        process.env.IS_PROD = originalIsProd;
    });
});
