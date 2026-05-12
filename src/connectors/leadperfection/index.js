/* eslint-disable no-param-reassign */
const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { UserModel } = require('@app-connect/core/models/userModel');
const { Lock } = require('@app-connect/core/models/dynamo/lockSchema');
const { LOG_DETAILS_FORMAT_TYPE } = require('@app-connect/core/lib/constants');
const logger = require('@app-connect/core/lib/logger');
const { handleDatabaseError } = require('@app-connect/core/lib/errorHandler');
const { encode, decoded } = require('@app-connect/core/lib/encode');

const DEFAULT_LP_BASE_URL = 'https://apitest.leadperfection.com';
const LP_TOKEN_LOCK_TTL_SECONDS = 30;
const TOKEN_EXPIRY_BUFFER_MINUTES = 2;
const CONTACT_LOOKUP_CACHE_TTL_MS = 10000;
const DEFAULT_CONTACT_LOOKUP_RETRY_MS = 30000;

const contactLookupCache = new Map();
const contactLookupRateLimits = new Map();

function getAuthType() {
    return 'oauth';
}

function getLogFormatType() {
    return LOG_DETAILS_FORMAT_TYPE.HTML;
}

function getBaseUrl(user) {
    const baseUrl = user?.platformAdditionalInfo?.apiUrl || process.env.LP_BASE_URL || DEFAULT_LP_BASE_URL;
    return String(baseUrl).replace(/\/$/, '');
}

function getTokenUrl({ tokenUrl, user } = {}) {
    return tokenUrl || user?.platformAdditionalInfo?.tokenUrl || `${getBaseUrl(user)}/token`;
}

function deriveClientIdFromHostname(hostname) {
    if (!hostname || typeof hostname !== 'string') {
        return '';
    }
    const label = hostname.split('.')[0];
    if (!label || label === 'www') {
        return '';
    }
    return label;
}

function resolveClientId({ payload, user, hostname } = {}) {
    return payload?.clientId
        || user?.platformAdditionalInfo?.clientId
        || process.env.LP_CLIENT_ID
        || deriveClientIdFromHostname(hostname || user?.hostname)
        || '';
}

function parseOpaqueAuthCode(code) {
    if (!code) {
        return null;
    }
    try {
        return JSON.parse(decoded(code));
    }
    catch (error) {
        logger.error('Invalid LeadPerfection auth code', { stack: error.stack });
        return null;
    }
}

function getAuthPayloadFromCallbackUri(callbackUri) {
    try {
        const code = new URL(callbackUri).searchParams.get('code');
        return parseOpaqueAuthCode(code);
    }
    catch (error) {
        return null;
    }
}

function resolveTokenExpiry(authData) {
    if (!authData) {
        return null;
    }
    if (authData.expires instanceof Date) {
        return authData.expires;
    }
    if (authData['.expires']) {
        return new Date(authData['.expires']);
    }
    if (authData.expires_in) {
        return moment().add(Number(authData.expires_in), 'seconds').toDate();
    }
    return null;
}

async function getOauthInfo({ tokenUrl, hostname }) {
    return {
        clientId: process.env.LP_OAUTH_CLIENT_ID || resolveClientId({ hostname }) || 'leadperfection',
        clientSecret: process.env.LP_OAUTH_CLIENT_SECRET || process.env.LP_APPKEY || 'leadperfection',
        accessTokenUri: getTokenUrl({ tokenUrl }),
        redirectUri: process.env.LP_REDIRECT_URI || 'https://ringcentral.github.io/ringcentral-embeddable/redirect.html'
    };
}

function getOverridingOAuthOption({ code }) {
    const payload = parseOpaqueAuthCode(code) || {};
    return {
        query: {
            grant_type: 'password',
            username: payload.username || '',
            password: payload.password || '',
            clientid: resolveClientId({ payload }),
            appkey: process.env.LP_APPKEY || ''
        },
        headers: {
            Authorization: ''
        }
    };
}

async function tokenRequest({ user, tokenUrl, params }) {
    return axios.post(
        getTokenUrl({ tokenUrl, user }),
        new URLSearchParams(params),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );
}

async function leadperfectionPasswordAuthorize(user, payload = {}) {
    const username = payload.username || decoded(user?.platformAdditionalInfo?.encodedApiUsername || '');
    const password = payload.password || decoded(user?.platformAdditionalInfo?.encodedApiPassword || '');
    if (!username || !password) {
        logger.error('LeadPerfection password authorize failed: missing username/password');
        return null;
    }
    try {
        logger.info('authorize leadperfection by password');
        const tokenResponse = await tokenRequest({
            user,
            params: {
                grant_type: 'password',
                username,
                password,
                clientid: resolveClientId({ payload, user }),
                appkey: process.env.LP_APPKEY || ''
            }
        });
        logger.info('authorize leadperfection user by password successfully.');
        return tokenResponse.data;
    }
    catch (error) {
        logger.error('LeadPerfection password authorize failed', { stack: error.stack });
        return null;
    }
}

async function exchangeOAuthCallback({ callbackUri, tokenUrl, hostname }) {
    const payload = getAuthPayloadFromCallbackUri(callbackUri) || {};
    const tokenResponse = await tokenRequest({
        tokenUrl,
        params: {
            grant_type: 'password',
            username: payload.username || '',
            password: payload.password || '',
            clientid: resolveClientId({ payload, hostname }),
            appkey: process.env.LP_APPKEY || ''
        }
    });
    return {
        accessToken: tokenResponse.data.access_token,
        refreshToken: tokenResponse.data.refresh_token,
        expires: resolveTokenExpiry(tokenResponse.data),
        data: tokenResponse.data
    };
}

async function refreshLeadPerfectionToken(user) {
    try {
        logger.info('LeadPerfection token refreshing...');
        const refreshResponse = await tokenRequest({
            user,
            params: {
                grant_type: 'refresh_token',
                refresh_token: user.refreshToken,
                clientid: resolveClientId({ user }),
                appkey: process.env.LP_APPKEY || ''
            }
        });
        return refreshResponse.data;
    }
    catch (error) {
        logger.error('LeadPerfection refresh token request failed', { stack: error.stack });
        return null;
    }
}

async function saveUserSession(user, authData) {
    if (!user || !authData?.access_token) {
        return null;
    }
    user.accessToken = authData.access_token;
    user.refreshToken = authData.refresh_token || '';
    user.tokenExpiry = resolveTokenExpiry(authData);
    try {
        await user.save();
    }
    catch (error) {
        return handleDatabaseError(error, 'Error saving user');
    }
    return user;
}

async function withTokenLock(user, tokenLockTimeout, refreshFn, skipLock = false) {
    let newLock;
    const dateNow = moment();
    try {
        if (!skipLock) {
            try {
                newLock = await Lock.create(
                    {
                        userId: user.id,
                        ttl: dateNow.unix() + LP_TOKEN_LOCK_TTL_SECONDS
                    },
                    {
                        overwrite: false
                    }
                );
            }
            catch (error) {
                if (error.name !== 'ConditionalCheckFailedException'
                    && error.__type !== 'com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException') {
                    throw error;
                }
                let lock = await Lock.get({ userId: user.id });
                if (lock && lock.ttl && Number(lock.ttl) < dateNow.unix()) {
                    try {
                        await lock.delete();
                        newLock = await Lock.create(
                            {
                                userId: user.id,
                                ttl: dateNow.unix() + LP_TOKEN_LOCK_TTL_SECONDS
                            },
                            {
                                overwrite: false
                            }
                        );
                    }
                    catch (error2) {
                        if (error2.name !== 'ConditionalCheckFailedException'
                            && error2.__type !== 'com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException') {
                            throw error2;
                        }
                        lock = await Lock.get({ userId: user.id });
                    }
                }
                if (lock && !newLock) {
                    let processTime = 0;
                    let delay = 500;
                    const maxDelay = 8000;
                    while (lock && processTime < tokenLockTimeout) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                        processTime += delay / 1000;
                        delay = Math.min(delay * 2, maxDelay);
                        lock = await Lock.get({ userId: user.id });
                    }
                    if (processTime >= tokenLockTimeout) {
                        throw new Error('LeadPerfection token lock timeout');
                    }
                    return UserModel.findByPk(user.id);
                }
            }
        }
        return await refreshFn();
    }
    finally {
        if (newLock) {
            await newLock.delete();
        }
    }
}

async function checkAndRefreshAccessToken(_oauthApp, user, tokenLockTimeout = 20, skipLock = false) {
    if (!user || !user.accessToken) {
        return user;
    }
    const tokenExpiry = moment(user.tokenExpiry);
    if (tokenExpiry.isValid() && tokenExpiry.isAfter(moment().add(TOKEN_EXPIRY_BUFFER_MINUTES, 'minutes'))) {
        return user;
    }
    return withTokenLock(user, tokenLockTimeout, async () => {
        let authData = null;
        if (user.refreshToken) {
            authData = await refreshLeadPerfectionToken(user);
        }
        if (!authData) {
            authData = await leadperfectionPasswordAuthorize(user);
        }
        if (!authData) {
            return null;
        }
        return saveUserSession(user, authData);
    }, skipLock);
}

async function getUserInfo({ tokenUrl, hostname, callbackUri, data }) {
    try {
        const authPayload = getAuthPayloadFromCallbackUri(callbackUri) || {};
        const tokenData = data || {};
        const userData = tokenData.user_data || tokenData.userData || {};
        const permissions = Array.isArray(userData.Settings) ? userData.Settings : [];
        const rawId = userData.EmpID
            || userData.empid
            || userData.EmployeeID
            || userData.employeeId
            || userData.ID
            || userData.id
            || authPayload.username;
        const id = `${String(rawId)}-leadperfection`;
        const name = userData.Name
            || userData.name
            || userData.FullName
            || userData.fullName
            || authPayload.username
            || 'LeadPerfection User';
        const timezoneOffset = userData.TimeZoneOffset
            || userData.timezoneOffset
            || '+00:00';
        const platformAdditionalInfo = {
            apiUrl: getBaseUrl(),
            tokenUrl: getTokenUrl({ tokenUrl }),
            clientId: resolveClientId({ payload: authPayload, hostname }),
            employeeId: userData.EmpID || userData.empid || userData.EmployeeID || userData.employeeId || null,
            permissions,
            encodedApiUsername: authPayload.username ? encode(authPayload.username) : '',
            encodedApiPassword: authPayload.password ? encode(authPayload.password) : ''
        };
        return {
            successful: true,
            platformUserInfo: {
                id,
                name,
                timezoneName: '',
                timezoneOffset,
                platformAdditionalInfo
            },
            returnMessage: {
                messageType: 'success',
                message: 'Connected to LeadPerfection.',
                ttl: 1000
            }
        };
    }
    catch (error) {
        logger.error('Error getting LeadPerfection user info', { stack: error.stack });
        return {
            successful: false,
            returnMessage: {
                messageType: 'warning',
                message: 'Could not load user information',
                ttl: 5000
            }
        };
    }
}

async function unAuthorize({ user }) {
    user.accessToken = '';
    user.refreshToken = '';
    try {
        await user.save();
    }
    catch (error) {
        return handleDatabaseError(error, 'Error saving user');
    }
    return {
        returnMessage: {
            messageType: 'success',
            message: 'Logged out of LeadPerfection',
            ttl: 1000
        }
    };
}

function getBearerHeaders(user, authHeader) {
    return {
        Authorization: authHeader || `Bearer ${user.accessToken}`,
        'Content-Type': 'application/json'
    };
}

async function callLeadPerfectionApi({ user, authHeader, path, body }) {
    return axios.post(
        `${getBaseUrl(user)}${path}`,
        body,
        {
            headers: getBearerHeaders(user, authHeader)
        }
    );
}

function getPhoneVariants(phoneNumber) {
    const cleaned = String(phoneNumber || '').trim();
    const normalized = cleaned.replace(/\s+/g, '');
    const digits = normalized.replace(/\D/g, '');
    const variants = new Set([cleaned, normalized, digits]);
    try {
        const parsed = parsePhoneNumber(normalized.includes('+') ? normalized : `+${digits}`);
        if (parsed.valid) {
            variants.add(parsed.number.e164);
            variants.add(parsed.number.significant);
            variants.add(parsed.number.national.replace(/\D/g, ''));
        }
    }
    catch (error) {
        // Fall back to the raw variants above.
    }
    return Array.from(variants).filter(Boolean);
}

function getNormalizedLookupPhone(phoneNumber) {
    const digits = String(phoneNumber || '').replace(/\D/g, '');
    return digits || String(phoneNumber || '').trim();
}

function getContactLookupCacheKey(user, phoneNumber) {
    return `${user?.id || 'anonymous'}:${getNormalizedLookupPhone(phoneNumber)}`;
}

function cloneMatchedContactInfo(matchedContactInfo = []) {
    return matchedContactInfo.map(contact => ({
        ...contact,
        additionalInfo: contact.additionalInfo ? { ...contact.additionalInfo } : contact.additionalInfo
    }));
}

function cloneFindContactResult(result) {
    return {
        ...result,
        matchedContactInfo: cloneMatchedContactInfo(result?.matchedContactInfo)
    };
}

function getRateLimitRetryMs(error) {
    const retryAfterSeconds = Number(error?.response?.data?.retryAfterSeconds);
    if (retryAfterSeconds > 0) {
        return retryAfterSeconds * 1000;
    }
    const retryAfterHeader = Number(error?.response?.headers?.['retry-after']);
    if (retryAfterHeader > 0) {
        return retryAfterHeader * 1000;
    }
    return DEFAULT_CONTACT_LOOKUP_RETRY_MS;
}

function getCachedContactLookupResult(cacheKey) {
    const cacheEntry = contactLookupCache.get(cacheKey);
    if (!cacheEntry?.result || !cacheEntry.expiresAt || cacheEntry.expiresAt <= Date.now()) {
        return null;
    }
    return cloneFindContactResult(cacheEntry.result);
}

function cleanupContactLookupCacheEntry(cacheKey, inFlight) {
    const existingEntry = contactLookupCache.get(cacheKey);
    if (!existingEntry || existingEntry.inFlight !== inFlight) {
        return;
    }
    delete existingEntry.inFlight;
    if (!existingEntry.result && !existingEntry.expiresAt) {
        contactLookupCache.delete(cacheKey);
        return;
    }
    contactLookupCache.set(cacheKey, existingEntry);
}

function setCachedContactLookupResult(cacheKey, result) {
    const existingEntry = contactLookupCache.get(cacheKey) || {};
    existingEntry.result = cloneFindContactResult(result);
    existingEntry.expiresAt = Date.now() + CONTACT_LOOKUP_CACHE_TTL_MS;
    contactLookupCache.set(cacheKey, existingEntry);
}

function normalizeLeadPerfectionArray(data) {
    if (Array.isArray(data)) {
        return data;
    }
    if (!data || typeof data !== 'object') {
        return [];
    }
    const arrayCandidateKeys = ['data', 'Data', 'results', 'Results', 'customers', 'Customers', 'value', 'Value'];
    for (const key of arrayCandidateKeys) {
        if (Array.isArray(data[key])) {
            return data[key];
        }
    }
    const nestedArray = Object.values(data).find(value => Array.isArray(value));
    return Array.isArray(nestedArray) ? nestedArray : [];
}

function normalizeContactRecord(record, fallbackPhone) {
    const custId = record.CustID || record.custid || record.CustomerID || record.customerid || null;
    const leadId = record.LeadID || record.leadid || record.ProspectID || record.prospectid || null;
    const id = custId || leadId || record.ID || record.id;
    if (!id) {
        return null;
    }
    const firstName = record.FirstName || record.firstname || '';
    const lastName = record.LastName || record.lastname || '';
    const derivedName = [firstName, lastName].filter(Boolean).join(' ').trim();
    const name = record.Name || record.name || record.CustomerName || record.customerName || derivedName || fallbackPhone;
    const phone = record.Phone || record.phone || record.Phone1 || record.phone1 || record.MobilePhone || record.mobilePhone || fallbackPhone;
    const additionalInfo = {
        custId,
        leadId
    };
    return {
        id: String(id),
        name,
        phone,
        type: leadId && !custId ? 'Lead' : 'Contact',
        mostRecentActivityDate: record.ModifiedDate || record.modifiedDate || record.LastUpdated || record.lastUpdated || null,
        additionalInfo: additionalInfo.custId || additionalInfo.leadId ? additionalInfo : null
    };
}

function getLeadPerfectionContactId(contactInfo) {
    const leadId = contactInfo?.additionalInfo?.leadId;
    const custId = contactInfo?.additionalInfo?.custId;
    if (contactInfo?.type === 'Lead' && (leadId || !custId)) {
        return {
            key: 'LeadID',
            value: leadId || contactInfo.id
        };
    }
    return {
        key: 'CustID',
        value: custId || contactInfo.id
    };
}

function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    const hours = String(Math.floor(safeSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((safeSeconds % 3600) / 60)).padStart(2, '0');
    const remainingSeconds = String(safeSeconds % 60).padStart(2, '0');
    return `${hours}:${minutes}:${remainingSeconds}`;
}

function getCallPhoneNumber(contactInfo, callLog) {
    if (callLog?.direction === 'Outbound') {
        return callLog?.to?.phoneNumber || contactInfo?.phone || '';
    }
    return callLog?.from?.phoneNumber || contactInfo?.phone || '';
}

async function authValidation({ user }) {
    try {
        await callLeadPerfectionApi({
            user,
            path: '/api/Customers/GetCustomers3',
            body: { phone: '0000000000' }
        });
        return {
            successful: true,
            status: 200
        };
    }
    catch (error) {
        if (error.response?.status === 401 || error.response?.status === 403) {
            user = await checkAndRefreshAccessToken(null, user);
            if (!user) {
                return {
                    successful: false,
                    returnMessage: {
                        messageType: 'warning',
                        message: 'It seems like your LeadPerfection session has expired. Please re-connect.',
                        ttl: 3000
                    },
                    status: error.response.status
                };
            }
            await callLeadPerfectionApi({
                user,
                path: '/api/Customers/GetCustomers3',
                body: { phone: '0000000000' }
            });
            return {
                successful: true,
                status: 200
            };
        }
        throw error;
    }
}

async function findContact({ user, authHeader, phoneNumber, isExtension }) {
    if (isExtension === 'true') {
        return {
            successful: false,
            matchedContactInfo: []
        };
    }
    const variants = getPhoneVariants(phoneNumber);
    if (variants.length === 0) {
        return {
            successful: false,
            returnMessage: {
                messageType: 'warning',
                message: 'Invalid phone number format',
                ttl: 3000
            },
            matchedContactInfo: []
        };
    }
    const cacheKey = getContactLookupCacheKey(user, phoneNumber);
    const userRateLimitKey = user?.id || 'anonymous';
    const cachedResult = getCachedContactLookupResult(cacheKey);
    const rateLimitedUntil = contactLookupRateLimits.get(userRateLimitKey) || 0;
    if (rateLimitedUntil > Date.now()) {
        return cachedResult || {
            successful: true,
            matchedContactInfo: []
        };
    }
    const inFlightLookup = contactLookupCache.get(cacheKey)?.inFlight;
    if (inFlightLookup) {
        return inFlightLookup;
    }
    if (cachedResult) {
        return cachedResult;
    }
    const dedupedContacts = new Map();
    const lookupPromise = (async () => {
        try {
            for (const variant of variants) {
                const response = await callLeadPerfectionApi({
                    user,
                    authHeader,
                    path: '/api/Customers/GetCustomers3',
                    body: { phone: variant }
                });
                for (const row of normalizeLeadPerfectionArray(response.data)) {
                    const normalizedContact = normalizeContactRecord(row, phoneNumber);
                    if (normalizedContact && !dedupedContacts.has(normalizedContact.id)) {
                        dedupedContacts.set(normalizedContact.id, normalizedContact);
                    }
                }
                if (dedupedContacts.size > 0) {
                    break;
                }
            }

            const matchedContactInfo = Array.from(dedupedContacts.values());
            if (matchedContactInfo.length === 0) {
                matchedContactInfo.push({
                    id: 'createNewContact',
                    name: 'Create new contact...',
                    isNewContact: true,
                    defaultContactType: 'Lead'
                });
            }
            const result = {
                successful: true,
                matchedContactInfo
            };
            setCachedContactLookupResult(cacheKey, result);
            return result;
        }
        catch (error) {
            if (error.response?.status === 429) {
                const retryMs = getRateLimitRetryMs(error);
                contactLookupRateLimits.set(userRateLimitKey, Date.now() + retryMs);
                logger.warn('LeadPerfection contact lookup rate limited; serving cached/empty result', {
                    platform: user?.platform,
                    userId: user?.id,
                    retryAfterMs: retryMs,
                    phoneNumber: getNormalizedLookupPhone(phoneNumber)
                });
                return cachedResult || {
                    successful: true,
                    matchedContactInfo: []
                };
            }
            throw error;
        }
        finally {
            cleanupContactLookupCacheEntry(cacheKey, lookupPromise);
        }
    })();
    const cacheEntry = contactLookupCache.get(cacheKey) || {};
    cacheEntry.inFlight = lookupPromise;
    contactLookupCache.set(cacheKey, cacheEntry);
    return lookupPromise;
}

async function findContactWithName() {
    return {
        successful: true,
        matchedContactInfo: []
    };
}

async function createContact({ user, authHeader, phoneNumber, newContactName }) {
    const [firstName, ...rest] = String(newContactName || '').trim().split(/\s+/);
    const response = await callLeadPerfectionApi({
        user,
        authHeader,
        path: '/api/Leads/LeadAdd',
        body: {
            firstname: firstName || '',
            lastname: rest.join(' '),
            phone: phoneNumber
        }
    });
    const payload = response.data || {};
    const contactId = payload.prospectid || payload.ProspectID || payload.LeadID || payload.CustID || payload.id || payload.ID;
    return {
        contactInfo: {
            id: String(contactId || phoneNumber),
            name: newContactName,
            type: 'Lead',
            additionalInfo: {
                leadId: contactId || null,
                custId: null
            }
        },
        returnMessage: {
            message: 'Contact created.',
            messageType: 'success',
            ttl: 2000
        }
    };
}

async function createCallLog({ user, contactInfo, callLog, additionalSubmission }) {
    const contactId = getLeadPerfectionContactId(contactInfo);
    const payload = {
        EmpID: user.platformAdditionalInfo?.employeeId || undefined,
        CallDate: moment(callLog.startTime).format('YYYY-MM-DD HH:mm:ss'),
        ResultCode: additionalSubmission?.resultCode || callLog?.resultCode || undefined,
        Phone: getCallPhoneNumber(contactInfo, callLog),
        CallType: callLog.direction === 'Outbound' ? 'Outbound' : 'Inbound',
        Duration: formatDuration(callLog.duration),
        RecordingURL: callLog?.recording?.link || additionalSubmission?.recordingUrl || undefined
    };
    payload[contactId.key] = contactId.value;

    const response = await callLeadPerfectionApi({
        user,
        path: '/api/Customers/AddCallHistory',
        body: payload
    });
    const responseData = response.data || {};
    return {
        logId: responseData.CallHistoryID || responseData.callHistoryId || responseData.id || callLog.sessionId,
        returnMessage: {
            message: 'Call logged',
            messageType: 'success',
            ttl: 2000
        }
    };
}

async function updateCallLog() {
    return {
        updatedNote: null,
        returnMessage: {
            message: 'LeadPerfection call log updates are not implemented yet.',
            messageType: 'warning',
            ttl: 3000
        }
    };
}

async function upsertCallDisposition() {
    return {
        logId: null
    };
}

async function createMessageLog() {
    return {
        logId: null,
        returnMessage: {
            message: 'LeadPerfection message logging is not implemented yet.',
            messageType: 'warning',
            ttl: 3000
        }
    };
}

async function updateMessageLog() {
    return {
        returnMessage: {
            message: 'LeadPerfection message log updates are not implemented yet.',
            messageType: 'warning',
            ttl: 3000
        }
    };
}

async function getCallLog() {
    return {
        callLogInfo: null
    };
}

async function getUserList() {
    return [];
}

async function getServerLoggingSettings() {
    return {};
}

async function updateServerLoggingSettings() {
    return {
        successful: true,
        returnMessage: {
            messageType: 'success',
            message: 'LeadPerfection does not use server logging settings in Phase 0.',
            ttl: 2000
        }
    };
}

async function postSaveUserInfo({ userInfo }) {
    return userInfo;
}

exports.getAuthType = getAuthType;
exports.authValidation = authValidation;
exports.getOauthInfo = getOauthInfo;
exports.exchangeOAuthCallback = exchangeOAuthCallback;
exports.checkAndRefreshAccessToken = checkAndRefreshAccessToken;
exports.getOverridingOAuthOption = getOverridingOAuthOption;
exports.getUserInfo = getUserInfo;
exports.createCallLog = createCallLog;
exports.updateCallLog = updateCallLog;
exports.upsertCallDisposition = upsertCallDisposition;
exports.createMessageLog = createMessageLog;
exports.updateMessageLog = updateMessageLog;
exports.getCallLog = getCallLog;
exports.findContact = findContact;
exports.createContact = createContact;
exports.unAuthorize = unAuthorize;
exports.findContactWithName = findContactWithName;
exports.getUserList = getUserList;
exports.getServerLoggingSettings = getServerLoggingSettings;
exports.updateServerLoggingSettings = updateServerLoggingSettings;
exports.postSaveUserInfo = postSaveUserInfo;
exports.getLogFormatType = getLogFormatType;
