/* eslint-disable no-param-reassign */
const axios = require('axios');
const { randomUUID } = require('crypto');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { UserModel } = require('@app-connect/core/models/userModel');
const {
    acquireTokenRefreshLock,
    getTokenRefreshLock,
    releaseTokenRefreshLock
} = require('@app-connect/core/models/tokenRefreshLockModel');
const { LOG_DETAILS_FORMAT_TYPE } = require('@app-connect/core/lib/constants');
const logger = require('@app-connect/core/lib/logger');
const { handleDatabaseError } = require('@app-connect/core/lib/errorHandler');
const { encode, decoded } = require('@app-connect/core/lib/encode');

const connectorManifest = require('../manifest.json');

// The extension only renders a 'selection' additionalField when the matched
// contact's additionalInfo carries an option list under the field's const;
// inline manifest options are ignored by the client.
const callLogDropdownOptions = (() => {
    const fields = connectorManifest.platforms?.leadperfection?.page?.callLog?.additionalFields ?? [];
    const optionsByField = {};
    for (const field of fields) {
        if (field?.type === 'selection' && Array.isArray(field.options)) {
            optionsByField[field.const] = field.options;
        }
    }
    return optionsByField;
})();

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
    if (skipLock) {
        return refreshFn();
    }

    const ownerId = randomUUID();
    let ownsLock = await acquireTokenRefreshLock({
        userId: user.id,
        ownerId,
        ttlSeconds: LP_TOKEN_LOCK_TTL_SECONDS
    });

    const timeoutMs = Math.max(0, Number(tokenLockTimeout) * 1000);
    const deadline = Date.now() + timeoutMs;
    let delay = 500;
    const maxDelay = 8000;

    try {
        while (!ownsLock && Date.now() < deadline) {
            const lock = await getTokenRefreshLock(user.id);
            if (!lock) {
                return UserModel.findByPk(user.id);
            }

            const expiresAt = Number(lock.expiresAt);
            if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
                ownsLock = await acquireTokenRefreshLock({
                    userId: user.id,
                    ownerId,
                    ttlSeconds: LP_TOKEN_LOCK_TTL_SECONDS
                });
                if (ownsLock) {
                    break;
                }
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs > 0) {
                await new Promise(resolve => setTimeout(resolve, Math.min(delay, remainingMs)));
                delay = Math.min(delay * 2, maxDelay);
            }
        }

        if (!ownsLock) {
            throw new Error('LeadPerfection token lock timeout');
        }

        return await refreshFn();
    }
    finally {
        if (ownsLock) {
            await releaseTokenRefreshLock({ userId: user.id, ownerId });
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
    const headers = getBearerHeaders(user, authHeader);
    if (body instanceof URLSearchParams) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    return axios.post(
        `${getBaseUrl(user)}${path}`,
        body,
        { headers }
    );
}

function getPhoneVariants(phoneNumber) {
    const cleaned = String(phoneNumber || '').trim();
    const normalized = cleaned.replace(/\s+/g, '');
    const digits = normalized.replace(/\D/g, '');
    const variants = new Set([cleaned, normalized, digits]);
    if (digits.length === 10) {
        variants.add(`1${digits}`);
        variants.add(`+1${digits}`);
    }
    if (digits.length === 11 && digits.startsWith('1')) {
        variants.add(digits.slice(1));
        variants.add(`+${digits}`);
    }
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

function isLeadPerfectionContactRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return false;
    }
    return Boolean(
        record.CustID
        || record.custid
        || record.CustomerID
        || record.customerid
        || record.LeadID
        || record.leadid
        || record.ProspectID
        || record.prospectid
        || record.CustomerName
        || record.customerName
    );
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
        if (isLeadPerfectionContactRecord(data[key])) {
            return [data[key]];
        }
    }
    if (isLeadPerfectionContactRecord(data)) {
        return [data];
    }
    const nestedArray = Object.values(data).find(value => Array.isArray(value));
    if (Array.isArray(nestedArray)) {
        return nestedArray;
    }
    const nestedRecord = Object.values(data).find(value => isLeadPerfectionContactRecord(value));
    return nestedRecord ? [nestedRecord] : [];
}

function summarizeLeadPerfectionLookupPayload(data) {
    if (Array.isArray(data)) {
        return {
            shape: 'array',
            count: data.length,
            firstRecord: data[0] || null
        };
    }
    if (!data || typeof data !== 'object') {
        return {
            shape: typeof data,
            count: 0,
            firstRecord: null
        };
    }
    const normalized = normalizeLeadPerfectionArray(data);
    return {
        shape: 'object',
        keys: Object.keys(data),
        count: normalized.length,
        firstRecord: normalized[0] || null
    };
}

function normalizeContactRecord(record, fallbackPhone) {
    const custId = record.CustID || record.custid || record.CustomerID || record.customerid || null;
    const leadId = record.LeadID || record.leadid || record.ProspectID || record.prospectid || null;
    const prospectId = record.ProspectID || record.prospectid || null;
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
        leadId,
        prospectId,
        ...callLogDropdownOptions
    };
    return {
        id: String(id),
        name,
        phone,
        type: leadId && !custId ? 'Lead' : 'Contact',
        mostRecentActivityDate: record.ModifiedDate || record.modifiedDate || record.LastUpdated || record.lastUpdated || null,
        additionalInfo
    };
}

function getLeadPerfectionContactId(contactInfo) {
    const leadId = contactInfo?.additionalInfo?.leadId;
    const prospectId = contactInfo?.additionalInfo?.prospectId;
    const custId = contactInfo?.additionalInfo?.custId;
    if (contactInfo?.type === 'Lead' && (leadId || !custId)) {
        return {
            key: 'ProspectID',
            value: prospectId || leadId || contactInfo.id
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

// The extension appends a 'None' option to every selection dropdown and
// submits it as the literal string 'none' — treat that as "not selected".
function getSubmittedSelection(value) {
    return value && value !== 'none' ? value : undefined;
}

function getCallType(callLog, additionalSubmission) {
    const submittedCallType = getSubmittedSelection(additionalSubmission?.callType);
    if (submittedCallType) {
        return submittedCallType;
    }
    if (callLog?.direction === 'Outbound') {
        return process.env.LP_OUTBOUND_CALL_TYPE || process.env.LP_DEFAULT_CALL_TYPE || 'O';
    }
    return process.env.LP_INBOUND_CALL_TYPE || process.env.LP_DEFAULT_CALL_TYPE || 'O';
}

function getResultCode(callLog, additionalSubmission) {
    return getSubmittedSelection(additionalSubmission?.resultCode)
        || getSubmittedSelection(callLog?.resultCode)
        || process.env.LP_DEFAULT_RESULT_CODE
        || 'NA';
}

function getEmployeeId(user) {
    return user.platformAdditionalInfo?.employeeId || process.env.LP_EMPLOYEE_ID || undefined;
}

function getDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function getLeadPerfectionError(responseData) {
    if (!Array.isArray(responseData)) {
        return null;
    }
    const failedResult = responseData.find(item => Number(item?.Result) === 0 && item?.Message);
    return failedResult?.Message || null;
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
    if (process.env.IS_PROD === 'false') {
        logger.info('LeadPerfection findContact lookup started', {
            userId: user?.id,
            hostname: user?.hostname,
            phoneNumber,
            variants
        });
    }
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
                const normalizedRows = normalizeLeadPerfectionArray(response.data);
                if (process.env.IS_PROD === 'false') {
                    logger.info('LeadPerfection findContact lookup response', {
                        userId: user?.id,
                        variant,
                        summary: summarizeLeadPerfectionLookupPayload(response.data)
                    });
                }
                for (const row of normalizedRows) {
                    const normalizedContact = normalizeContactRecord(row, phoneNumber);
                    if (normalizedContact && !dedupedContacts.has(normalizedContact.id)) {
                        dedupedContacts.set(normalizedContact.id, normalizedContact);
                    }
                }
                if (process.env.IS_PROD === 'false') {
                    logger.info('LeadPerfection findContact normalized matches', {
                        userId: user?.id,
                        variant,
                        matchCount: dedupedContacts.size,
                        matches: Array.from(dedupedContacts.values()).map(contact => ({
                            id: contact.id,
                            name: contact.name,
                            phone: contact.phone,
                            type: contact.type
                        }))
                    });
                }
                if (dedupedContacts.size > 0) {
                    break;
                }
            }

            const matchedContactInfo = Array.from(dedupedContacts.values());
            if (matchedContactInfo.length === 0) {
                if (process.env.IS_PROD === 'false') {
                    logger.warn('LeadPerfection findContact lookup returned no matches', {
                        userId: user?.id,
                        phoneNumber,
                        variants
                    });
                }
                matchedContactInfo.push({
                    id: 'createNewContact',
                    name: 'Create new contact...',
                    isNewContact: true,
                    defaultContactType: 'Lead',
                    additionalInfo: { ...callLogDropdownOptions }
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
                custId: null,
                ...callLogDropdownOptions
            }
        },
        returnMessage: {
            message: 'Contact created.',
            messageType: 'success',
            ttl: 2000
        }
    };
}

// AddNotes attaches to the record's Notes tab. rectype: cst=Prospect,
// ils=Issued Lead, job=Job Detail; nct_id (note category) defaults to 1.
async function addLeadPerfectionNote({ user, contactInfo, note }) {
    const noteText = String(note || '').trim();
    if (!noteText) {
        return { attempted: false };
    }
    const recId = contactInfo?.additionalInfo?.prospectId
        || contactInfo?.additionalInfo?.leadId
        || contactInfo?.additionalInfo?.custId
        || contactInfo?.id;
    const body = new URLSearchParams({
        rectype: 'cst',
        recid: String(recId),
        notes: noteText
    });
    if (process.env.LP_NOTE_CATEGORY_ID) {
        body.append('nct_id', process.env.LP_NOTE_CATEGORY_ID);
    }
    const response = await callLeadPerfectionApi({
        user,
        path: '/api/SalesApi/AddNotes',
        body
    });
    logger.info('LeadPerfection AddNotes response', {
        userId: user?.id,
        recId,
        status: response.status,
        responseData: response.data
    });
    const failureMessage = getLeadPerfectionError(response.data)
        || (typeof response.data === 'string' && !/success/i.test(response.data) ? response.data : null);
    return {
        attempted: true,
        successful: !failureMessage,
        message: failureMessage
    };
}

async function createCallLog({ user, contactInfo, callLog, note, additionalSubmission }) {
    const contactId = getLeadPerfectionContactId(contactInfo);
    const payload = {
        EmpID: getEmployeeId(user),
        CallDate: moment(callLog.startTime).format('YYYY-MM-DD HH:mm:ss'),
        ResultCode: getResultCode(callLog, additionalSubmission),
        Phone: getDigits(getCallPhoneNumber(contactInfo, callLog)),
        CallType: getCallType(callLog, additionalSubmission),
        Duration: formatDuration(callLog.duration),
        RecordingURL: callLog?.recording?.link || additionalSubmission?.recordingUrl || undefined
    };
    if (process.env.LP_CALL_QUEUE_ID) {
        payload.CallQueueID = process.env.LP_CALL_QUEUE_ID;
    }
    payload[contactId.key] = contactId.value;

    logger.info('LeadPerfection createCallLog payload', {
        userId: user?.id,
        contactId,
        payload
    });

    const response = await callLeadPerfectionApi({
        user,
        path: '/api/Customers/AddCallHistory',
        body: payload
    });
    const responseData = response.data || {};
    logger.info('LeadPerfection createCallLog response', {
        userId: user?.id,
        contactId,
        status: response.status,
        responseData
    });
    const lpError = getLeadPerfectionError(responseData);
    if (lpError) {
        return {
            logId: null,
            returnMessage: {
                message: lpError,
                messageType: 'warning',
                ttl: 5000
            }
        };
    }
    let noteOutcome = { attempted: false };
    try {
        noteOutcome = await addLeadPerfectionNote({ user, contactInfo, note });
    }
    catch (error) {
        logger.error('LeadPerfection AddNotes failed', {
            userId: user?.id,
            contactId,
            status: error.response?.status,
            responseData: error.response?.data
        });
        noteOutcome = { attempted: true, successful: false, message: error.message };
    }
    const logId = responseData.CallHistoryID || responseData.callHistoryId || responseData.id || callLog.sessionId;
    if (noteOutcome.attempted && !noteOutcome.successful) {
        return {
            logId,
            returnMessage: {
                message: `Call logged, but the note could not be saved${noteOutcome.message ? `: ${noteOutcome.message}` : '.'}`,
                messageType: 'warning',
                ttl: 5000
            }
        };
    }
    return {
        logId,
        returnMessage: {
            message: noteOutcome.attempted ? 'Call logged and note saved' : 'Call logged',
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
