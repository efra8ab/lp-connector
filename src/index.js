const {
    createCoreApp,
    connectorRegistry,
    proxyConnector
} = require('@app-connect/core');
const path = require('path');
const { UserModel } = require('@app-connect/core/models/userModel');
const jwt = require('@app-connect/core/lib/jwt');
const axios = require('axios');
const bullhorn = require('./connectors/bullhorn');
const bullhornReport = require('./connectors/bullhorn/report');
const clio = require('./connectors/clio');
const googleSheets = require('./connectors/googleSheets');
const insightly = require('./connectors/insightly');
const leadperfection = require('./connectors/leadperfection');
const netsuite = require('./connectors/netsuite');
const pipedrive = require('./connectors/pipedrive');
const redtail = require('./connectors/redtail');
const googleSheetsExtra = require('./connectors/googleSheets/extra.js');
const logger = require('@app-connect/core/lib/logger');
const adminCore = require('@app-connect/core/handlers/admin');
const { encode } = require('@app-connect/core/lib/encode');
const googleDrivePlugin = require('./plugins/googleDrivePlugin');
const allCapPlugin = require('./plugins/allCapPlugin');
// Register connectors
connectorRegistry.setDefaultManifest(require('./connectors/manifest.json'));
connectorRegistry.setReleaseNotes(require('./releaseNotes.json'));

connectorRegistry.registerConnector('bullhorn', bullhorn);
connectorRegistry.registerConnector('clio', clio);
connectorRegistry.registerConnector('googleSheets', googleSheets);
connectorRegistry.registerConnector('insightly', insightly);
connectorRegistry.registerConnector('leadperfection', leadperfection);
connectorRegistry.registerConnector('discountbath.lp_connector__dev_test', leadperfection);
connectorRegistry.registerConnector('netsuite', netsuite);
connectorRegistry.registerConnector('pipedrive', pipedrive);
connectorRegistry.registerConnector('redtail', redtail);
connectorRegistry.registerConnector('proxy', proxyConnector);

// Create Express app with core functionality
const app = createCoreApp();

const { PluginUserModel } = require('./plugins/models/pluginUserModel');
const { GoogleDriveFileModel } = require('./plugins/models/googleDriveFileModel');
async function initDB() {
    if (!process.env.DISABLE_SYNC_DB_TABLE) {
        console.log('creating db tables if not exist...');
        await PluginUserModel.sync();
        await GoogleDriveFileModel.sync();
    }
}

initDB();

function renderLeadPerfectionAuthPage({ username = '', error = '', redirectUri = '', state = '', hostname = '', clientId = '' }) {
    const errorHtml = error ? `<p style="margin:0 0 16px;color:#b42318;background:#fef3f2;border:1px solid #fecdca;padding:12px 14px;border-radius:10px;">${error}</p>` : '';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LeadPerfection Sign In</title>
  <style>
    :root {
      --bg: #f5efe2;
      --panel: #fffaf0;
      --line: #d8c8a8;
      --text: #1f2937;
      --muted: #6b7280;
      --accent: #8a4b14;
      --accent-strong: #6b3207;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Georgia, "Times New Roman", serif;
      background:
        radial-gradient(circle at top left, rgba(198, 146, 82, 0.25), transparent 32%),
        linear-gradient(160deg, #f8f2e8 0%, var(--bg) 48%, #ead8bc 100%);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .panel {
      width: min(100%, 460px);
      background: rgba(255, 250, 240, 0.96);
      border: 1px solid rgba(138, 75, 20, 0.18);
      border-radius: 18px;
      box-shadow: 0 24px 60px rgba(78, 45, 14, 0.16);
      padding: 28px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 30px;
      line-height: 1.1;
    }
    p {
      margin: 0 0 18px;
      color: var(--muted);
      line-height: 1.5;
    }
    label {
      display: block;
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .field {
      margin-bottom: 16px;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 16px;
      background: #fff;
      color: var(--text);
    }
    .meta {
      margin: 0 0 18px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(138, 75, 20, 0.08);
      color: var(--text);
      font-size: 14px;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 12px;
      padding: 13px 16px;
      font-size: 16px;
      font-weight: 700;
      color: #fff;
      background: linear-gradient(180deg, var(--accent), var(--accent-strong));
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main class="panel">
    <h1>LeadPerfection</h1>
    <p>Sign in with your LeadPerfection username and password to connect RingCentral App Connect.</p>
    ${errorHtml}
    <div class="meta">
      <strong>Client ID:</strong> ${clientId || 'Not configured'}<br>
      <strong>Hostname:</strong> ${hostname || 'Unknown'}
    </div>
    <form method="post" action="/leadperfection/auth">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="hostname" value="${hostname}">
      <input type="hidden" name="clientId" value="${clientId}">
      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" required value="${username}">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button type="submit">Connect</button>
    </form>
  </main>
</body>
</html>`;
}

function getLeadPerfectionClientId({ hostname }) {
    return process.env.LP_CLIENT_ID || (hostname ? hostname.split('.')[0] : '');
}

// Add custom routes for specific connectors
// Google Sheets specific routes
app.get('/googleSheets/filePicker', async function (req, res) {
    try {
        const jwtToken = req.query.token;
        if (jwtToken) {
            const unAuthData = jwt.decodeJwt(jwtToken);
            const user = await UserModel.findByPk(unAuthData?.id);
            if (!user) {
                res.status(400).send();
                return;
            }
            const fileContent = await googleSheetsExtra.renderPickerFile({ user });
            res.send(fileContent);
        } else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        logger.error('Error getting file picker', { stack: e.stack });
        res.status(500).send(e);
    }
});

app.post('/googleSheets/sheet', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (jwtToken) {
            const unAuthData = jwt.decodeJwt(jwtToken);
            const user = await UserModel.findByPk(unAuthData?.id);
            if (!user) {
                res.status(400).send();
                return;
            }
            const { successful, sheetName, sheetUrl } = await googleSheetsExtra.createNewSheet({ user, data: req.body });
            if (successful) {
                res.status(200).send({
                    name: sheetName,
                    url: sheetUrl
                });
                return;
            }
            else {
                res.status(500).send('Failed to create new sheet');
                return;
            }
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
            return;
        }
    }
    catch (e) {
        logger.error('Error creating new sheet', { stack: e.stack });
        res.status(500).send(e);
    }
});

app.delete('/googleSheets/sheet', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (jwtToken) {
            const unAuthData = jwt.decodeJwt(jwtToken);
            const user = await UserModel.findByPk(unAuthData?.id);
            if (!user) {
                res.status(400).send();
                return;
            }
            await googleSheetsExtra.removeSheet({ user });
            res.status(200).send('Sheet removed');
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        logger.error('Error removing sheet', { stack: e.stack });
        res.status(500).send(e);
    }
});

app.post('/googleSheets/selectedSheet', async function (req, res) {
    const authHeader = `Bearer ${req.body.accessToken}`;
    const response = await axios.get(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: {
            Authorization: authHeader
        }
    });
    const data = response?.data;
    const user = await UserModel.findByPk(`${data?.sub}-googleSheets`);
    if (!user) {
        res.status(400).send('User not found');
        return;
    }
    await googleSheetsExtra.updateSelectedSheet({ user, data: req.body });

    res.status(200).send({ message: 'Sheet selected', Id: req.body.field });
});

// Google Sheets admin routes
app.get('/admin/googleSheets/filePicker', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (jwtToken) {
            const unAuthData = jwt.decodeJwt(jwtToken);
            const user = await UserModel.findByPk(unAuthData?.id);
            if (!user) {
                res.status(400).send('User not found');
                return;
            }
            const fileContent = await googleSheetsExtra.renderAdminPickerFile({ user, rcAccessToken: req.query.rcAccessToken });
            res.send(fileContent);
        } else {
            res.status(400).send('Please authorize admin access');
        }
    }
    catch (e) {
        res.status(500).send(e);
    }
});

app.post('/admin/googleSheets/sheet', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (jwtToken) {
            const unAuthData = jwt.decodeJwt(jwtToken);
            const user = await UserModel.findByPk(unAuthData?.id);
            if (!user) {
                res.status(400).send('User not found');
                return;
            }
            const { isValidated, rcAccountId } = await adminCore.validateAdminRole({ rcAccessToken: req.query.rcAccessToken });
            if (isValidated) {
                const { successful, sheetName, sheetUrl } = await googleSheetsExtra.createNewSheet({ user, data: req.body });
                if (successful) {
                    // Store admin configuration
                    await googleSheetsExtra.setAdminGoogleSheetsConfig({
                        rcAccountId,
                        sheetName,
                        sheetUrl,
                        customizable: req.body.customizable || false
                    });
                    res.status(200).send({
                        name: sheetName,
                        url: sheetUrl
                    });
                } else {
                    res.status(500).send('Failed to create new sheet');
                }
            } else {
                res.status(403).send('Admin validation failed');
            }
        }
    }
    catch (e) {
        res.status(500).send(e);
    }
});

app.post('/admin/googleSheets/selectedSheet', async function (req, res) {
    try {
        const authHeader = `Bearer ${req.body.accessToken}`;
        const response = await axios.get(`https://www.googleapis.com/oauth2/v3/userinfo`, {
            headers: {
                Authorization: authHeader
            }
        });
        const data = response?.data;
        const user = await UserModel.findByPk(`${data?.sub}-googleSheets`);
        if (!user) {
            res.status(400).send('User not found');
            return;
        }
        const { isValidated, rcAccountId } = await adminCore.validateAdminRole({ rcAccessToken: req.query.rcAccessToken });
        if (isValidated) {
            const { successful, sheetName, sheetUrl } = await googleSheetsExtra.updateSelectedSheet({ user, data: req.body });
            if (successful) {
                // Store admin configuration
                await googleSheetsExtra.setAdminGoogleSheetsConfig({
                    rcAccountId,
                    sheetName,
                    sheetUrl,
                    customizable: req.body.customizable || false
                });
                res.status(200).send({ message: 'Admin sheet configuration saved', Id: req.body.field });
            } else {
                res.status(500).send('Failed to configure sheet');
            }
        } else {
            res.status(403).send('Admin validation failed');
        }
    }
    catch (e) {
        res.status(500).send(e);
    }
});

app.get('/admin/googleSheets/config', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (jwtToken) {
            const unAuthData = jwt.decodeJwt(jwtToken);
            const user = await UserModel.findByPk(unAuthData?.id);
            if (!user) {
                res.status(400).send('User not found');
                return;
            }
            const { isValidated, rcAccountId } = await adminCore.validateAdminRole({ rcAccessToken: req.query.rcAccessToken });
            if (isValidated) {
                const config = await googleSheetsExtra.getAdminGoogleSheetsConfig({ rcAccountId });
                res.status(200).send(config);
            } else {
                res.status(403).send('Admin validation failed');
            }
        } else {
            res.status(400).send('Please authorize admin access');
        }
    }
    catch (e) {
        res.status(500).send(e);
    }
});

// Pipedrive specific routes
app.get('/pipedrive-redirect', function (req, res) {
    try {
        res.sendFile(path.join(__dirname, 'connectors/pipedrive/redirect.html'));
    }
    catch (e) {
        logger.error('Error getting pipedrive redirect', { stack: e.stack });
        res.status(500).send(e);
    }
});

app.delete('/pipedrive-redirect', async function (req, res) {
    try {
        const basicAuthHeader = Buffer.from(`${process.env.PIPEDRIVE_CLIENT_ID}:${process.env.PIPEDRIVE_CLIENT_SECRET}`).toString('base64');
        if (`Basic ${basicAuthHeader}` === req.get('authorization')) {
            const userId = req.body.user_id;
            if (!userId) {
                res.status(400).send('Missing user_id');
                return;
            }

            // Find the user to get refresh token for revocation
            const user = await UserModel.findByPk(userId);
            if (user) {
                const platformModule = require(`./connectors/pipedrive`);
                await platformModule.unAuthorize({ user });
                await UserModel.destroy({
                    where: {
                        id: userId,
                        platform: 'pipedrive'
                    }
                });
            }
            res.status(200).send('User deleted');
        } else {
            res.status(401).send('Unauthorized');
        }
    }
    catch (e) {
        logger.error('Error removing pipedrive redirect', { stack: e.stack });
        res.status(500).send(e);
    }
});

app.get('/leadperfection/auth', function (req, res) {
    try {
        const state = req.query.state || '';
        const stateParams = new URLSearchParams(state ? decodeURIComponent(state) : '');
        const hostname = req.query.hostname || stateParams.get('hostname') || '';
        const redirectUri = req.query.redirect_uri || '';
        const clientId = getLeadPerfectionClientId({ hostname });
        res.send(renderLeadPerfectionAuthPage({
            redirectUri,
            state,
            hostname,
            clientId
        }));
    }
    catch (e) {
        logger.error('Error rendering LeadPerfection auth page', { stack: e.stack });
        res.status(500).send('Could not render LeadPerfection auth page');
    }
});

app.post('/leadperfection/auth', function (req, res) {
    try {
        const redirectUri = req.body?.redirect_uri;
        const state = req.body?.state;
        const username = req.body?.username?.trim();
        const password = req.body?.password;
        const hostname = req.body?.hostname || '';
        const clientId = req.body?.clientId || getLeadPerfectionClientId({ hostname });
        if (!redirectUri || !state || !username || !password) {
            res.status(400).send(renderLeadPerfectionAuthPage({
                redirectUri,
                state,
                hostname,
                clientId,
                username,
                error: 'Username and password are required.'
            }));
            return;
        }
        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set('code', encode(JSON.stringify({
            username,
            password,
            hostname,
            clientId
        })));
        redirectUrl.searchParams.set('state', state);
        res.redirect(302, redirectUrl.toString());
    }
    catch (e) {
        logger.error('Error submitting LeadPerfection auth page', { stack: e.stack });
        res.status(500).send('LeadPerfection sign-in failed');
    }
});

app.get('/plugin/licenseStatus/:pluginId', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        const { id: userId, platform } = jwt.decodeJwt(jwtToken);
        const user = await UserModel.findByPk(userId);
        if (!user) {
            res.status(400).send('User not found');
            return;
        }
        const pluginId = req.params.pluginId;
        switch (pluginId) {
            case 'googleDrive':
                const { isSuccessful } = await googleDrivePlugin.checkAuth({ userId });
                const errorMessage = [
                    'License is invalid'
                ]
                if (!isSuccessful) {
                    errorMessage.push('Google Drive user is not authorized')
                }
                res.status(200).send({
                    licenseStatus: false,
                    errorMessage: errorMessage.join(' AND '),
                    licenseStatusDescription: 'Invalid. Please go [here](https://www.google.com)'
                });
                break;
            case 'allCap':
                res.status(200).send({
                    licenseStatus: true,
                    licenseStatusDescription: 'License: Basic'
                });
                break;
            default:
                res.status(400).send('Unknown plugin');
                return;
        }
    }
    catch (e) {
        logger.error('Error getting plugin license status', { stack: e.stack });
        res.status(500).send(e);
    }
});

app.post('/plugin/:pluginId', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        const { id: userId, platform } = jwt.decodeJwt(jwtToken);
        const user = await UserModel.findByPk(userId);
        if (!user) {
            res.status(400).send('User not found');
            return;
        }
        let result;
        switch (req.params.pluginId) {
            case 'googleDrive':
                result = googleDrivePlugin.uploadToGoogleDrive({ user, data: req.body.data, taskId: req.body.asyncTaskId });
                break;
            case 'all_cap':
                result = allCapPlugin.allCap({ user, data: req.body.data });
                break;
            default:
                res.status(400).send('Unknown plugin');
                return;
        }

        res.status(200).send(result);
    }
    catch (e) {
        console.log(e.stack);
        res.status(400).send();
    }
});

app.get('/googleDrive/oauthUrl', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!jwtToken) {
            res.status(400).send('JWT token is required');
            return;
        }
        const result = await googleDrivePlugin.getOAuthUrl({ jwtToken, pluginId: req.query.pluginId });
        res.status(200).send(result);
    }
    catch (e) {
        console.log(e.stack);
        res.status(400).send();
    }
});

app.get('/googleDrive/oauthCallback', async function (req, res) {
    try {
        const state = req.query.callbackUri.split('state=')[1];
        // add params back to callbackUri
        const callbackUri = `${req.query.callbackUri}&code=${req.query.code}&scope=${req.query.scope}`;
        const stateJson = JSON.parse(decodeURIComponent(state));
        const jwtToken = stateJson.jwtToken;
        const pluginId = stateJson.pluginId;
        const { id: userId, platform } = jwt.decodeJwt(jwtToken);
        const user = await UserModel.findByPk(userId);
        if (!user) {
            res.status(400).send('User not found');
            return;
        }
        await googleDrivePlugin.onOAuthCallback({ user, callbackUri });
        res.status(200).send({ pluginId });
    }
    catch (e) {
        console.log(e.stack);
        res.status(400).send();
    }
});

app.get('/googleDrive/checkAuth', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!jwtToken) {
            res.status(400).send('JWT token is required');
            return;
        }
        const { id: userId, platform } = jwt.decodeJwt(jwtToken);
        const result = await googleDrivePlugin.checkAuth({ userId });
        res.status(200).send(result);
    }
    catch (e) {
        console.log(e.stack);
        res.status(400).send();
    }
});

app.post('/googleDrive/logout', async function (req, res) {
    try {
        const jwtToken = req.body.jwtToken;
        if (!jwtToken) {
            res.status(400).send('JWT token is required');
            return;
        }
        const { id: userId, platform } = jwt.decodeJwt(jwtToken);
        const result = await googleDrivePlugin.logout({ userId });
        res.status(200).send(result);
    }
    catch (e) {
        console.log(e.stack);
        res.status(400).send();
    }
});

// // Internal-only: manually trigger Bullhorn monthly report w/ Salesforce data
// app.get('/internal/bullhorn/monthly-salesforce-report', async function (req, res) {
//     try {

//         //await bullhorn.generateMontlyCsvReportWithSalesforceData();
//         await bullhornReport.sendMonthlyCsvReportByEmailWithSalesforceData();
//         console.log({message:'Bullhorn Salesforce monthly report generated successfully'});
//         res.status(200).send({ ok: true });
//     }
//     catch (e) {
//         logger.error('Failed to generate Bullhorn Salesforce monthly report', { stack: e.stack });
//         res.status(500).send({ ok: false, error: e && e.message ? e.message : 'Unknown error' });
//     }
// });

exports.getServer = function getServer() {
    return app;
}
