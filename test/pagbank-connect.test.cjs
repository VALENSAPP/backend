const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// Execute the real service/client with synthetic storage, transport and credentials.
// No Nest application, database or network connection is started.
function fixture(overrides = {}) {
    const env = {
        PAGBANK_ENV: 'sandbox',
        PAGBANK_TOKEN: 'synthetic-platform-token',
        PAGBANK_CLIENT_ID: 'synthetic-client',
        PAGBANK_CLIENT_SECRET: 'synthetic-client-secret',
        BACKEND_URL: 'https://backend.example.test',
        ...overrides,
    };
    const clock = { now: Date.UTC(2026, 9, 29, 12) };
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
    }
    const user = { id: 'receiver-user', pagbankAccountId: null, pagbankAccessToken: null };
    const updates = [], requests = [], logs = [];
    const transport = {
        response: {
            access_token: 'synthetic-seller-token',
            refresh_token: 'synthetic-refresh-token',
            account_id: 'ACCO_SYNTHETIC_SELLER',
            expires_in: 3600,
        },
        error: null,
    };
    async function post(defaults, url, body, config) {
        requests.push({ defaults, url, body, config });
        if (transport.error) throw transport.error;
        return { data: transport.response };
    }
    const axios = {
        create: defaults => ({ post: (url, body, config) => post(defaults, url, body, config) }),
        post: (url, body, config) => post({}, url, body, config),
    };
    class BadRequestException extends Error { getStatus() { return 400; } }
    class Logger {
        error(message) { logs.push(String(message)); }
        warn(message) { logs.push(String(message)); }
        log(message) { logs.push(String(message)); }
    }
    const shared = {
        '@nestjs/common': { Injectable: () => target => target, BadRequestException, Logger },
        axios: { __esModule: true, default: axios },
        '../common/payment-provider.util': { normalizeCountryCode: value => value },
    };
    function load(relative) {
        const filename = path.resolve(__dirname, '..', relative);
        const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            fileName: filename,
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                esModuleInterop: true,
                experimentalDecorators: true,
            },
            reportDiagnostics: true,
        });
        assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
        const module = { exports: {} };
        vm.runInNewContext(result.outputText, {
            module, exports: module.exports, Buffer, URLSearchParams, Date: ClockDate,
            process: { env },
            require(name) {
                if (Object.hasOwn(shared, name)) return shared[name];
                if (['crypto', 'fs', 'https'].includes(name)) return require(name);
                if (name.startsWith('.')) return {};
                throw new Error(`Unexpected dependency: ${name}`);
            },
        }, { filename });
        return module.exports;
    }
    const { PagBankClient } = load('src/pagbank/pagbank.client.ts');
    const { PagBankService } = load('src/pagbank/pagbank.service.ts');
    const prisma = { user: {
        findUnique: async () => ({ ...user }),
        update: async ({ data }) => { updates.push(data); Object.assign(user, data); return { ...user }; },
    } };
    const service = new PagBankService(prisma, new PagBankClient(), {}, {}, {});
    async function state() {
        const link = await service.createAccountOnboardingLink(user.id);
        return new URL(link.onboardingUrl).searchParams.get('state');
    }
    return { env, clock, user, updates, requests, logs, transport, service, state };
}

async function callback(f, state) {
    return f.service.handleConnectCallback({ code: 'synthetic-authorization-code', state: state ?? await f.state() });
}

test('link uses Sandbox, the configured callback, and distinct states within 128 characters', async () => {
    const f = fixture();
    const link = await f.service.createAccountOnboardingLink(f.user.id);
    const url = new URL(link.onboardingUrl);
    assert.equal(url.host, 'connect.sandbox.pagbank.com.br');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://backend.example.test/billing/pagbank/callback');
    const first = url.searchParams.get('state');
    assert.ok(first.length <= 128);
    assert.notEqual(first, await f.state());
});

test('a UUID receiver fits the provider state limit and survives the real callback method', async () => {
    const f = fixture();
    f.user.id = '00000000-0000-4000-8000-000000000001';
    const state = await f.state();
    assert.ok(state.length <= 128);
    const result = await callback(f, state);
    assert.equal(result.userId, f.user.id);
});

test('unsigned user-id state is rejected before exchanging a code', async () => {
    const f = fixture();
    const unsigned = Buffer.from(JSON.stringify({ userId: f.user.id })).toString('base64url');
    await assert.rejects(callback(f, unsigned), /state/i);
    assert.equal(f.requests.length, 0);
    assert.equal(f.updates.length, 0);
});

test('a modified state cannot choose another receiver', async () => {
    const f = fixture();
    const original = await f.state();
    const modified = original.replace(f.user.id, 'different-user');
    assert.notEqual(modified, original);
    await assert.rejects(callback(f, modified), /state/i);
    assert.equal(f.requests.length, 0);
});

test('a modified signature is rejected before exchanging a code', async () => {
    const f = fixture();
    const original = await f.state();
    const last = original.at(-1);
    await assert.rejects(callback(f, original.slice(0, -1) + (last === 'A' ? 'B' : 'A')), /state/i);
    assert.equal(f.requests.length, 0);
});

test('state expires after 15 minutes', async () => {
    const f = fixture();
    const state = await f.state();
    f.clock.now += 15 * 60_000 + 1;
    await assert.rejects(callback(f, state), /state/i);
    assert.equal(f.requests.length, 0);
});

test('state from a clock more than one minute in the future is rejected', async () => {
    const f = fixture();
    const state = await f.state();
    f.clock.now -= 2 * 60_000;
    await assert.rejects(callback(f, state), /state/i);
    assert.equal(f.requests.length, 0);
});

for (const key of ['PAGBANK_CLIENT_ID', 'PAGBANK_TOKEN', 'BACKEND_URL']) {
    test(`state is bound to the configured ${key}`, async () => {
        const f = fixture();
        const state = await f.state();
        f.env[key] += '-changed';
        await assert.rejects(callback(f, state), /state/i);
        assert.equal(f.requests.length, 0);
    });
}

test('link requires the platform credential already used by the API', async () => {
    const f = fixture({ PAGBANK_TOKEN: undefined });
    await assert.rejects(f.state(), /token/i);
    assert.equal(f.requests.length, 0);
});

test('account-token alias remains supported', async () => {
    const f = fixture({ PAGBANK_TOKEN: undefined, PAGBANK_ACCOUNT_TOKEN: 'synthetic-account-token' });
    await callback(f);
    assert.equal(f.requests[0].defaults.headers.Authorization, 'Bearer synthetic-account-token');
});

test('callback exchanges once with platform authorization and matching client/redirect', async () => {
    const f = fixture();
    await callback(f);
    assert.equal(f.requests.length, 1);
    const request = f.requests[0];
    assert.equal(request.defaults.baseURL, 'https://sandbox.api.pagseguro.com');
    assert.equal(request.defaults.headers.Authorization, 'Bearer synthetic-platform-token');
    assert.equal(request.config.headers.X_CLIENT_ID, f.env.PAGBANK_CLIENT_ID);
    assert.equal(request.config.headers.X_CLIENT_SECRET, f.env.PAGBANK_CLIENT_SECRET);
    assert.equal(request.config.maxRedirects, 0);
    assert.equal(request.body.redirect_uri, 'https://backend.example.test/billing/pagbank/callback');
    assert.equal(request.body.grant_type, 'authorization_code');
    assert.equal(f.updates.length, 1);
    assert.equal(f.user.pagbankAccountId, 'ACCO_SYNTHETIC_SELLER');
    assert.equal(f.user.pagbankTokenExpiresAt.getTime(), f.clock.now + 3_600_000);
    assert.equal((await f.service.getOnboardingStatus(f.user.id)).canReceivePayments, true);
});

test('empty authorization code makes no exchange or persistence', async () => {
    const f = fixture();
    await assert.rejects(f.service.handleConnectCallback({ code: ' ', state: await f.state() }), /code/i);
    assert.equal(f.requests.length, 0);
    assert.equal(f.updates.length, 0);
});

for (const [name, response] of [
    ['no response', null],
    ['missing account', { access_token: 'synthetic-token', expires_in: 3600 }],
    ['blank account', { access_token: 'synthetic-token', account_id: ' ', expires_in: 3600 }],
    ['missing access token', { account_id: 'ACCO_SYNTHETIC', expires_in: 3600 }],
    ['missing expiry', { access_token: 'synthetic-token', account_id: 'ACCO_SYNTHETIC' }],
    ['invalid expiry', { access_token: 'synthetic-token', account_id: 'ACCO_SYNTHETIC', expires_in: 'invalid' }],
    ['expired token', { access_token: 'synthetic-token', account_id: 'ACCO_SYNTHETIC', expires_in: -1 }],
]) {
    test(`incomplete callback response (${name}) never overwrites a connection`, async () => {
        const f = fixture();
        f.user.pagbankAccountId = 'ACCO_PREVIOUS';
        f.user.pagbankAccessToken = 'synthetic-previous-token';
        f.transport.response = response;
        await assert.rejects(callback(f), /PagBank/);
        assert.equal(f.updates.length, 0);
        assert.equal(f.user.pagbankAccountId, 'ACCO_PREVIOUS');
        assert.equal(f.user.pagbankAccessToken, 'synthetic-previous-token');
    });
}

test('provider failures expose no response payload, code, state or credentials', async () => {
    const f = fixture();
    const secret = 'synthetic-private-error-value';
    f.transport.error = { message: secret, response: { status: 401, data: { message: secret, access_token: secret } } };
    let message;
    try { await callback(f); } catch (error) { message = error.message; }
    assert.ok(message);
    assert.equal(message.includes(secret), false);
    assert.equal(f.logs.join(' ').includes(secret), false);
    assert.equal(f.updates.length, 0);
});

test('refresh authenticates the platform, rotates credentials and preserves the receiver', async () => {
    const f = fixture();
    f.user.pagbankAccountId = 'ACCO_SYNTHETIC_SELLER';
    f.user.pagbankRefreshToken = 'synthetic-old-refresh';
    const token = await f.service.refreshSellerToken(f.user.id);
    assert.equal(token, 'synthetic-seller-token');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].defaults.headers.Authorization, 'Bearer synthetic-platform-token');
    assert.equal(f.requests[0].body.grant_type, 'refresh_token');
    assert.equal(f.user.pagbankRefreshToken, 'synthetic-refresh-token');
    assert.equal(f.user.pagbankAccountId, 'ACCO_SYNTHETIC_SELLER');
});

for (const response of [
    { access_token: 'new-token', refresh_token: 'new-refresh', account_id: 'ACCO_DIFFERENT', expires_in: 3600 },
    { refresh_token: 'new-refresh', expires_in: 3600 },
    { access_token: 'new-token', expires_in: 3600 },
    { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 0 },
]) {
    test('invalid refresh cannot overwrite tokens or switch the connected receiver', async () => {
        const f = fixture();
        f.user.pagbankAccountId = 'ACCO_PREVIOUS';
        f.user.pagbankAccessToken = 'synthetic-old-token';
        f.user.pagbankRefreshToken = 'synthetic-old-refresh';
        f.transport.response = response;
        await assert.rejects(f.service.refreshSellerToken(f.user.id), /PagBank/);
        assert.equal(f.updates.length, 0);
        assert.equal(f.user.pagbankAccountId, 'ACCO_PREVIOUS');
        assert.equal(f.user.pagbankAccessToken, 'synthetic-old-token');
    });
}

test('refresh may omit an unchanged account id', async () => {
    const f = fixture();
    f.user.pagbankAccountId = 'ACCO_PREVIOUS';
    f.user.pagbankRefreshToken = 'synthetic-old-refresh';
    delete f.transport.response.account_id;
    await f.service.refreshSellerToken(f.user.id);
    assert.equal(f.user.pagbankAccountId, 'ACCO_PREVIOUS');
});

test('failed refresh cannot report an expired connection as ready', async () => {
    const f = fixture();
    f.user.pagbankAccountId = 'ACCO_PREVIOUS';
    f.user.pagbankAccessToken = 'synthetic-old-token';
    f.user.pagbankRefreshToken = 'synthetic-old-refresh';
    f.user.pagbankTokenExpiresAt = new Date(f.clock.now - 1);
    f.transport.response = {};
    assert.equal((await f.service.getOnboardingStatus(f.user.id)).canReceivePayments, false);
    assert.equal(f.updates.length, 0);
});

test('a user without an authorization stays pending', async () => {
    const f = fixture();
    assert.equal((await f.service.getOnboardingStatus(f.user.id)).canReceivePayments, false);
    assert.equal(f.requests.length, 0);
});
