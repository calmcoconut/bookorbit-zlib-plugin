#!/usr/bin/env node
/**
 * BookOrbit Z-Library Plugin Verification Suite
 *
 * Runs offline with: node plugins/zlibrary/verify.mjs
 * Zero external npm dependencies (Node.js standard library only).
 * Validates all 11 test categories specified in Phase 7.1 of the plugin specification.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Import plugin implementation (supporting both named exports and _internals)
import plugin, * as namedExports from './index.mjs';

const internals = plugin._internals || namedExports;
const parseAndValidateCredential =
  namedExports.parseAndValidateCredential ||
  plugin._internals?.parseAndValidateCredential ||
  plugin.parseAndValidateCredential;
const sanitizeHttpsOrigin =
  namedExports.sanitizeHttpsOrigin ||
  plugin._internals?.sanitizeHttpsOrigin ||
  plugin.sanitizeHttpsOrigin;
const trustedMirrors =
  namedExports.trustedMirrors ||
  plugin._internals?.trustedMirrors ||
  plugin.trustedMirrors;
const classifyApiEnvelope =
  namedExports.classifyApiEnvelope ||
  plugin._internals?.classifyApiEnvelope ||
  plugin.classifyApiEnvelope;
const parseBookGuid =
  namedExports.parseBookGuid ||
  plugin._internals?.parseBookGuid ||
  plugin.parseBookGuid;
const validateBookIdentity =
  namedExports.validateBookIdentity ||
  plugin._internals?.validateBookIdentity ||
  plugin.validateBookIdentity;
const validateAndBuildFileDetails =
  namedExports.validateAndBuildFileDetails ||
  plugin._internals?.validateAndBuildFileDetails ||
  plugin.validateAndBuildFileDetails;
const parseAllowedFormats =
  namedExports.parseAllowedFormats ||
  plugin._internals?.parseAllowedFormats ||
  plugin.parseAllowedFormats;
const configAffinity =
  namedExports.configAffinity ||
  plugin._internals?.configAffinity ||
  plugin.configAffinity;
const setConfigAffinity =
  namedExports.setConfigAffinity ||
  plugin._internals?.setConfigAffinity ||
  plugin.setConfigAffinity;
const truncateUtf8 =
  namedExports.truncateUtf8 ||
  plugin._internals?.truncateUtf8 ||
  plugin.truncateUtf8;
const sanitizeBaseName =
  namedExports.sanitizeBaseName ||
  plugin._internals?.sanitizeBaseName ||
  plugin.sanitizeBaseName;

// --- Load Test Fixtures ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures');

const searchFixture = JSON.parse(await readFile(join(fixturesDir, 'search.json'), 'utf-8'));
const profileFixture = JSON.parse(await readFile(join(fixturesDir, 'profile.json'), 'utf-8'));
const fileFixture = JSON.parse(await readFile(join(fixturesDir, 'file.json'), 'utf-8'));
const fileLimitFixture = JSON.parse(await readFile(join(fixturesDir, 'file-limit.json'), 'utf-8'));
const sessionExpiredFixture = JSON.parse(await readFile(join(fixturesDir, 'session-expired.json'), 'utf-8'));
const authFailedFixture = JSON.parse(await readFile(join(fixturesDir, 'auth-failed.json'), 'utf-8'));
const challengeHtmlFixture = await readFile(join(fixturesDir, 'challenge.html'), 'utf-8');

// --- Mock Host & Network Harness ---

/**
 * Creates a mock BookOrbit host according to specification:
 * - host.fail(code, message): returns IndexerSearchException error
 * - host.buildSearchText(query): returns query.query or [title, author].join(' ')
 * - host.sanitizeCandidate(candidate): retains guid, title, bookTitle, author, format, sizeBytes, downloadUrl, language
 * - host.fetch(url, options): network simulation
 */
function createMockHost({ fetchHandler = null } = {}) {
  const calls = [];
  return {
    calls,
    fail(code, message) {
      const err = new Error(message);
      err.name = 'IndexerSearchException';
      err.failure = code;
      return err;
    },
    buildSearchText(query) {
      if (!query) return '';
      if (typeof query.query === 'string' && query.query.trim()) {
        return query.query.trim();
      }
      return [query.title, query.author].filter(Boolean).join(' ').trim();
    },
    sanitizeCandidate(candidate) {
      if (!candidate || typeof candidate !== 'object') return null;
      return {
        guid: candidate.guid,
        title: candidate.title,
        bookTitle: candidate.bookTitle || candidate.title,
        author: candidate.author,
        format: candidate.format,
        sizeBytes: candidate.sizeBytes,
        downloadUrl: candidate.downloadUrl,
        language: candidate.language,
      };
    },
    async fetch(url, options = {}) {
      calls.push({ url, options });
      if (options.signal?.aborted) {
        throw (options.signal.reason || new Error('Fetch aborted'));
      }
      if (typeof fetchHandler === 'function') {
        return await fetchHandler(url, options, calls.length - 1);
      }
      throw new Error(`Unhandled fetch request to ${url}`);
    },
  };
}

/**
 * Creates a mock HTTP response object.
 */
function mockResponse({
  status = 200,
  headers = {},
  body = null,
  json = null,
  abortOnJson = false,
  signal = null,
  onJson = null,
}) {
  const normalizedHeaders = new Map();
  for (const [k, v] of Object.entries(headers)) {
    normalizedHeaders.set(k.toLowerCase(), v);
  }
  if (json !== null && !normalizedHeaders.has('content-type')) {
    normalizedHeaders.set('content-type', 'application/json');
  }
  if (body !== null && !normalizedHeaders.has('content-type')) {
    normalizedHeaders.set('content-type', 'text/html');
  }

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return normalizedHeaders.get(name.toLowerCase()) || null;
      },
    },
    async text() {
      if (signal?.aborted) throw (signal.reason || new Error('Aborted in text()'));
      return body !== null ? body : JSON.stringify(json);
    },
    async json() {
      if (abortOnJson && signal) {
        throw (signal.reason || new Error('Aborted in json()'));
      }
      if (signal?.aborted) throw (signal.reason || new Error('Aborted in json()'));
      if (typeof onJson === 'function') {
        onJson();
      }
      if (json !== null) return JSON.parse(JSON.stringify(json));
      if (body !== null) return JSON.parse(body);
      throw new Error('No body available to parse as JSON');
    },
  };
}

// --- Test Runner State ---
let passedTests = 0;
let failedTests = 0;
const failures = [];

async function test(description, fn) {
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${description}`);
  } catch (err) {
    failedTests++;
    console.error(`  ✗ ${description}`);
    console.error(`    ${err?.stack || err}`);
    failures.push({ description, err });
  }
}

async function runCategory(title, fn) {
  console.log(`\n============================================================`);
  console.log(` Category: ${title}`);
  console.log(`============================================================`);
  await fn();
}

// =========================================================================
// Category 1: Credential Serialization & Header Injection Defense
// =========================================================================
await runCategory('1. Credential Serialization & Header Injection Defense', async () => {
  const host = createMockHost();
  const validUserId = '12345';
  const validUserKey = '0123456789abcdef0123456789abcdef';

  await test('1.1: Parses colon format <userid>:<userkey>', () => {
    const cred = parseAndValidateCredential({ credential: `${validUserId}:${validUserKey}` }, host);
    assert.deepEqual(cred, { userid: validUserId, userkey: validUserKey });
  });

  await test('1.2: Parses slash format <userid>/<userkey>', () => {
    const cred = parseAndValidateCredential({ credential: `${validUserId}/${validUserKey}` }, host);
    assert.deepEqual(cred, { userid: validUserId, userkey: validUserKey });
  });

  await test('1.3: Parses JSON format {"userid": "...", "userkey": "..."} and remix keys', () => {
    const cred1 = parseAndValidateCredential(
      { credential: JSON.stringify({ userid: validUserId, userkey: validUserKey }) },
      host
    );
    assert.deepEqual(cred1, { userid: validUserId, userkey: validUserKey });

    const cred2 = parseAndValidateCredential(
      { credential: JSON.stringify({ remix_userid: validUserId, remix_userkey: validUserKey }) },
      host
    );
    assert.deepEqual(cred2, { userid: validUserId, userkey: validUserKey });
  });

  await test('1.4: Auto-swap heuristic corrects reversed 32-hex key and numeric ID', () => {
    const cred = parseAndValidateCredential({ credential: `${validUserKey}:${validUserId}` }, host);
    assert.deepEqual(cred, { userid: validUserId, userkey: validUserKey });
  });

  await test('1.5: Rejects empty, missing, non-numeric ID or non-hex userkey with unauthorized', () => {
    const invalidInputs = [
      '',
      '   ',
      null,
      undefined,
      'abc:0123456789abcdef0123456789abcdef',
      '12345:0123456789abcdef0123456789abcdeg', // 'g' is non-hex
      '12345:0123456789abcdef', // too short (16 chars)
      '12345:0123456789abcdef0123456789abcdef0', // too long (33 chars)
      '12345',
    ];

    for (const input of invalidInputs) {
      assert.throws(
        () => parseAndValidateCredential({ credential: input }, host),
        (err) => err?.failure === 'unauthorized',
        `Should throw unauthorized for input: "${input}"`
      );
    }
  });

  await test('1.6: Outbound cookie header formatting includes remix credentials', async () => {
    let capturedHeaders = null;
    const mockHost = createMockHost({
      fetchHandler: async (url, options) => {
        capturedHeaders = options.headers;
        return mockResponse({ status: 200, json: { success: true, books: [] } });
      },
    });

    const config = {
      credential: `${validUserId}:${validUserKey}`,
      baseUrl: 'https://z-library.sk',
    };
    await plugin.search({ query: 'clean code' }, config, mockHost);

    assert.ok(capturedHeaders, 'fetch should have been invoked');
    const cookie = capturedHeaders['Cookie'] || capturedHeaders['cookie'];
    assert.ok(cookie, 'Cookie header must be present');
    assert.ok(
      cookie.includes(`remix_userid=${validUserId}`),
      `Cookie should contain remix_userid=${validUserId}`
    );
    assert.ok(
      cookie.includes(`remix_userkey=${validUserKey}`),
      `Cookie should contain remix_userkey=${validUserKey}`
    );
    assert.ok(cookie.includes('siteLanguageV2=en'), 'Cookie should include siteLanguageV2=en');
  });
});

// =========================================================================
// Category 2: Book-Hash & Two-Component GUID Validation
// =========================================================================
await runCategory('2. Book-Hash & Two-Component GUID Validation', async () => {
  await test('2.1: validateBookIdentity accepts realistic alphanumeric hashes', () => {
    assert.equal(validateBookIdentity('123456', 'b8f4a1'), true);
    assert.equal(validateBookIdentity('12345678', 'hash123'), true);
    assert.equal(validateBookIdentity(99999, '012345abcdef'), true);
    assert.equal(validateBookIdentity('123', 'a-b_c123'), true);
  });

  await test('2.2: ID bounds enforcement (1-20 digits)', () => {
    assert.equal(validateBookIdentity('1', 'hash123'), true);
    assert.equal(validateBookIdentity('12345678901234567890', 'hash123'), true); // 20 digits
    assert.equal(validateBookIdentity('123456789012345678901', 'hash123'), false); // 21 digits
    assert.equal(validateBookIdentity('123a', 'hash123'), false);
    assert.equal(validateBookIdentity('', 'hash123'), false);
  });

  await test('2.3: Hash bounds enforcement (1-32 chars alphanumeric, underscore, hyphen)', () => {
    assert.equal(validateBookIdentity('123', 'a'), true);
    assert.equal(validateBookIdentity('123', 'a'.repeat(32)), true);
    assert.equal(validateBookIdentity('123', 'a'.repeat(33)), false);
    assert.equal(validateBookIdentity('123', 'bad!hash'), false);
    assert.equal(validateBookIdentity('123', 'bad/hash'), false);
    assert.equal(validateBookIdentity('123', 'bad$hash'), false);
  });

  await test('2.4: parseBookGuid parses exactly 2 components and rejects invalid', () => {
    assert.deepEqual(parseBookGuid('12345/b8f4a1'), { bookId: '12345', bookHash: 'b8f4a1' });
    assert.equal(parseBookGuid('12345/b8f4a1/extra'), null);
    assert.equal(parseBookGuid('12345'), null);
    assert.equal(parseBookGuid(''), null);
    assert.equal(parseBookGuid(null), null);
    assert.equal(parseBookGuid('abc/b8f4a1'), null);
    assert.equal(parseBookGuid('12345/bad$hash'), null);
  });
});

// =========================================================================
// Category 3: HTTP 401 Precedence
// =========================================================================
await runCategory('3. HTTP 401 Precedence', async () => {
  const config = {
    credential: '12345:0123456789abcdef0123456789abcdef',
    baseUrl: 'https://z-library.sk',
    settings: { fallbackMirrors: 'https://z-library.gs, https://1lib.sk' },
  };

  await test('3.1: Search with HTTP 401 JSON body throws unauthorized immediately (no failover)', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 401,
          json: sessionExpiredFixture,
        });
      },
    });

    await assert.rejects(
      async () => plugin.search({ query: 'clean code' }, config, mockHost),
      (err) => err?.failure === 'unauthorized',
      'Should throw unauthorized on HTTP 401'
    );
    assert.equal(mockHost.calls.length, 1, 'HTTP 401 must NOT fail over to fallback mirrors');
  });

  await test('3.2: Search with HTTP 401 HTML body throws unauthorized immediately (no failover)', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 401,
          headers: { 'content-type': 'text/html' },
          body: '<html><body>401 Unauthorized</body></html>',
        });
      },
    });

    await assert.rejects(
      async () => plugin.search({ query: 'clean code' }, config, mockHost),
      (err) => err?.failure === 'unauthorized',
      'Should throw unauthorized on HTTP 401 HTML'
    );
    assert.equal(mockHost.calls.length, 1, 'HTTP 401 HTML must NOT be treated as challenge or fail over');
  });

  await test('3.3: resolveFile with HTTP 401 throws unauthorized immediately', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 401,
          json: sessionExpiredFixture,
        });
      },
    });

    const release = {
      guid: '1234567/b8f4a1',
      title: 'Clean Architecture',
      format: 'epub',
    };

    await assert.rejects(
      async () => plugin.resolveFile(release, config, mockHost),
      (err) => err?.failure === 'unauthorized',
      'Should throw unauthorized on HTTP 401 during resolveFile'
    );
  });
});

// =========================================================================
// Category 4: Cloudflare 403 Challenge vs JSON 403 Auth
// =========================================================================
await runCategory('4. Cloudflare 403 Challenge vs JSON 403 Auth', async () => {
  const config = {
    credential: '12345:0123456789abcdef0123456789abcdef',
    baseUrl: 'https://z-library.sk',
    settings: { fallbackMirrors: 'https://1lib.sk' },
  };

  await test('4.1: Cloudflare 403 HTML challenge triggers failover to mirror 2', async () => {
    const mockHost = createMockHost({
      fetchHandler: async (url) => {
        if (url.startsWith('https://z-library.sk')) {
          return mockResponse({
            status: 403,
            headers: { 'content-type': 'text/html' },
            body: challengeHtmlFixture,
          });
        }
        if (url.startsWith('https://1lib.sk')) {
          return mockResponse({
            status: 200,
            json: searchFixture,
          });
        }
        throw new Error(`Unexpected url: ${url}`);
      },
    });

    const results = await plugin.search({ query: 'architecture' }, config, mockHost);
    assert.equal(mockHost.calls.length, 2, 'Should fail over to mirror 2');
    assert.ok(Array.isArray(results) && results.length > 0, 'Search should succeed on mirror 2');
    assert.equal(results[0].guid, '1234567/b8f4a1');
  });

  await test('4.2: JSON 403 Auth failure throws unauthorized immediately (no failover)', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 403,
          headers: { 'content-type': 'application/json' },
          json: authFailedFixture,
        });
      },
    });

    await assert.rejects(
      async () => plugin.search({ query: 'architecture' }, config, mockHost),
      (err) => err?.failure === 'unauthorized',
      'JSON 403 auth error must throw unauthorized'
    );
    assert.equal(mockHost.calls.length, 1, 'JSON 403 auth failure must NOT fail over');
  });
});

// =========================================================================
// Category 5: Strict API Envelope Classification & Malformed Error Tracking
// =========================================================================
await runCategory('5. Strict API Envelope Classification & Malformed Error Tracking', async () => {
  const host = createMockHost();

  await test('5.1: Missing success: true treated as malformed envelope', () => {
    const malformedPayloads = [
      {},
      { books: [] },
      { success: 'true' }, // string instead of boolean
      { success: false, message: 'Unspecified internal server error' },
      null,
      [],
    ];

    for (const payload of malformedPayloads) {
      assert.throws(
        () => classifyApiEnvelope(payload, host, 'test'),
        (err) => err?.isEnvelopeError === true || err instanceof Error,
        `Should flag envelope error for payload: ${JSON.stringify(payload)}`
      );
    }
  });

  await test('5.2: All mirrors returning malformed payloads throws error (not unreachable)', async () => {
    const config = {
      credential: '12345:0123456789abcdef0123456789abcdef',
      baseUrl: 'https://z-library.sk',
      settings: { fallbackMirrors: 'https://1lib.sk' },
    };

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 200,
          json: { success: 'not-boolean', books: [] },
        });
      },
    });

    await assert.rejects(
      async () => plugin.search({ query: 'architecture' }, config, mockHost),
      (err) => {
        assert.equal(err?.failure, 'error', 'Must report failure code "error"');
        assert.ok(
          /invalid|malformed/i.test(err?.message || ''),
          `Message must indicate invalid API response: "${err?.message}"`
        );
        return true;
      }
    );
  });

  await test('5.3: Genuine empty { success: true, books: [] } returns empty array []', async () => {
    const config = {
      credential: '12345:0123456789abcdef0123456789abcdef',
      baseUrl: 'https://z-library.sk',
    };

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 200,
          json: { success: true, books: [] },
        });
      },
    });

    const results = await plugin.search({ query: 'nonexistentbook999' }, config, mockHost);
    assert.deepEqual(results, []);
  });

  await test('5.4: Quota exhaustion throws throttled failure', async () => {
    assert.throws(
      () => classifyApiEnvelope(fileLimitFixture, host, 'test'),
      (err) => err?.failure === 'throttled',
      'Should classify quota exhaustion as throttled'
    );

    const config = {
      credential: '12345:0123456789abcdef0123456789abcdef',
      baseUrl: 'https://z-library.sk',
    };

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({ status: 200, json: fileLimitFixture });
      },
    });

    const release = {
      guid: '1234567/b8f4a1',
      title: 'Clean Architecture',
      format: 'epub',
    };

    await assert.rejects(
      async () => plugin.resolveFile(release, config, mockHost),
      (err) => err?.failure === 'throttled',
      'resolveFile should throw throttled on quota exhaustion'
    );
  });

  await test('5.5: Malformed resolution envelope converts isEnvelopeError to host.fail("error")', async () => {
    const config = {
      credential: '12345:0123456789abcdef0123456789abcdef',
      baseUrl: 'https://z-library.sk',
    };

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({ status: 200, json: {} });
      },
    });

    const release = {
      guid: '1234567/b8f4a1',
      title: 'Clean Architecture',
      format: 'epub',
    };

    await assert.rejects(
      async () => plugin.resolveFile(release, config, mockHost),
      (err) => err?.failure === 'error',
      'resolveFile must convert isEnvelopeError to host.fail("error")'
    );
  });
});

// =========================================================================
// Category 6: URL Anti-Spoofing & Normalization
// =========================================================================
await runCategory('6. URL Anti-Spoofing & Normalization', async () => {
  const host = createMockHost();

  await test('6.1: Double scheme / authority spoofing rejected', () => {
    assert.equal(sanitizeHttpsOrigin('https://https://example.com'), null);
    assert.equal(sanitizeHttpsOrigin('https://example.com//evil.com'), null);
  });

  await test('6.2: Port normalization (443 stripped, non-standard retained)', () => {
    assert.equal(sanitizeHttpsOrigin('z-library.sk:443'), 'https://z-library.sk');
    assert.equal(sanitizeHttpsOrigin('https://z-library.sk:443'), 'https://z-library.sk');
    assert.equal(sanitizeHttpsOrigin('z-library.sk:8443'), 'https://z-library.sk:8443');
    assert.equal(sanitizeHttpsOrigin('https://z-library.sk:8443'), 'https://z-library.sk:8443');
  });

  await test('6.3: Insecure schemes rejected', () => {
    assert.equal(sanitizeHttpsOrigin('http://z-library.sk'), null);
    assert.equal(sanitizeHttpsOrigin('ftp://z-library.sk'), null);
    assert.equal(sanitizeHttpsOrigin('javascript:alert(1)'), null);
  });

  await test('6.4: Host validation rejects userinfo, bare host without dot, invalid ports', () => {
    assert.equal(sanitizeHttpsOrigin('https://user:pass@example.com'), null);
    assert.equal(sanitizeHttpsOrigin('user:pass@example.com'), null);
    assert.equal(sanitizeHttpsOrigin('badhost'), null);
    assert.equal(sanitizeHttpsOrigin('localhost'), 'https://localhost');
    assert.equal(sanitizeHttpsOrigin('example.com:0'), null);
    assert.equal(sanitizeHttpsOrigin('example.com:65536'), null);
    assert.equal(sanitizeHttpsOrigin('example.com/foo'), null);
  });

  await test('6.5: trustedMirrors respects fallbacks setting and clamps attempts', () => {
    assert.throws(
      () => trustedMirrors({ baseUrl: 'http://insecure.org' }, host),
      (err) => err?.failure === 'error'
    );

    // Empty string fallbackMirrors -> zero fallbacks
    const single = trustedMirrors(
      { baseUrl: 'https://z-library.sk', settings: { fallbackMirrors: '' } },
      host
    );
    assert.deepEqual(single, ['https://z-library.sk']);

    // Default fallbacks used when fallbackMirrors is undefined
    const def = trustedMirrors({ baseUrl: 'https://z-lib.gd' }, host);
    assert.ok(def.length >= 2);
    assert.equal(def[0], 'https://z-lib.gd');

    // Missing baseUrl defaults to https://z-lib.gd with active fallback mirrors
    const defOmitted = trustedMirrors({}, host);
    assert.equal(defOmitted[0], 'https://z-lib.gd');
    assert.deepEqual(defOmitted, ['https://z-lib.gd', 'https://z-lib.gl', 'https://singlelogin.rs']);

    // Clamps max attempts
    const clamped = trustedMirrors(
      {
        baseUrl: 'https://z-library.sk',
        settings: {
          fallbackMirrors: 'https://m1.example.com, https://m2.example.com, https://m3.example.com',
          maxMirrorAttempts: 2,
        },
      },
      host
    );
    assert.equal(clamped.length, 2);
  });
});

// =========================================================================
// Category 7: Cancellation & Mid-Flight Deadlines
// =========================================================================
await runCategory('7. Cancellation & Mid-Flight Deadlines', async () => {
  const config = {
    credential: '12345:0123456789abcdef0123456789abcdef',
    baseUrl: 'https://z-library.sk',
  };

  await test('7.1: Pre-aborted signal in search() re-throws signal.reason immediately', async () => {
    const controller = new AbortController();
    const customReason = new Error('Client aborted before search');
    controller.abort(customReason);

    const mockHost = createMockHost();
    await assert.rejects(
      async () => plugin.search({ query: 'clean code' }, config, mockHost, controller.signal),
      (err) => err === customReason
    );
    assert.equal(mockHost.calls.length, 0, 'No network calls when pre-aborted');
  });

  await test('7.2: Signal aborted during host.fetch() in search() re-throws signal.reason', async () => {
    const controller = new AbortController();
    const customReason = new Error('Client aborted mid-flight');

    const mockHost = createMockHost({
      fetchHandler: async () => {
        controller.abort(customReason);
        throw controller.signal.reason;
      },
    });

    await assert.rejects(
      async () => plugin.search({ query: 'clean code' }, config, mockHost, controller.signal),
      (err) => err === customReason
    );
  });

  await test('7.3: Signal aborted during response.json() in search() re-throws signal.reason', async () => {
    const controller = new AbortController();
    const customReason = new Error('Client aborted during JSON parse');

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 200,
          json: searchFixture,
          onJson: () => {
            controller.abort(customReason);
          },
        });
      },
    });

    await assert.rejects(
      async () => plugin.search({ query: 'clean code' }, config, mockHost, controller.signal),
      (err) => err === customReason
    );
  });

  await test('7.4: Pre-aborted signal in resolveFile() re-throws signal.reason', async () => {
    const controller = new AbortController();
    const customReason = new Error('Client aborted before resolveFile');
    controller.abort(customReason);

    const mockHost = createMockHost();
    const release = { guid: '1234567/b8f4a1', title: 'Clean Code', format: 'epub' };

    await assert.rejects(
      async () => plugin.resolveFile(release, config, mockHost, controller.signal),
      (err) => err === customReason
    );
    assert.equal(mockHost.calls.length, 0);
  });

  await test('7.5: Signal aborted during host.fetch() in resolveFile() re-throws signal.reason', async () => {
    const controller = new AbortController();
    const customReason = new Error('Resolution timeout aborted');

    const mockHost = createMockHost({
      fetchHandler: async () => {
        controller.abort(customReason);
        throw controller.signal.reason;
      },
    });

    const release = { guid: '1234567/b8f4a1', title: 'Clean Code', format: 'epub' };
    await assert.rejects(
      async () => plugin.resolveFile(release, config, mockHost, controller.signal),
      (err) => err === customReason
    );
  });

  await test('7.6: Signal aborted during response.json() in resolveFile() re-throws signal.reason', async () => {
    const controller = new AbortController();
    const customReason = new Error('Resolution body parse aborted');

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 200,
          json: fileFixture,
          onJson: () => {
            controller.abort(customReason);
          },
        });
      },
    });

    const release = { guid: '1234567/b8f4a1', title: 'Clean Code', format: 'epub' };
    await assert.rejects(
      async () => plugin.resolveFile(release, config, mockHost, controller.signal),
      (err) => err === customReason
    );
  });

  await test('7.7: Body reader aborting signal with valid empty books [] throws signal.reason and does not update affinity', async () => {
    const controller = new AbortController();
    const customReason = new Error('Client aborted during empty search read');
    const testConfig = {
      id: 'empty-abort-cfg',
      credential: '12345:0123456789abcdef0123456789abcdef',
      baseUrl: 'https://z-library.sk',
    };
    const key = 'empty-abort-cfg:12345';
    if (configAffinity) configAffinity.delete(key);

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 200,
          json: { success: true, books: [] },
          onJson: () => {
            controller.abort(customReason);
          },
        });
      },
    });

    await assert.rejects(
      async () => plugin.search({ query: 'nonexistent' }, testConfig, mockHost, controller.signal),
      (err) => err === customReason
    );
    assert.equal(configAffinity?.has?.(key), false, 'Must not set affinity when cancelled during response reading');
  });

  await test('7.8: Preflight cancellation preserves falsy reasons in search and resolution', async () => {
    for (const reason of [false, 0, '', null]) {
      for (const method of ['search', 'resolveFile']) {
        const controller = new AbortController();
        controller.abort(reason);
        const mockHost = createMockHost();
        const input = method === 'search'
          ? { query: 'clean code' }
          : { guid: '1234567/b8f4a1', title: 'Clean Code', format: 'epub' };
        await plugin[method](input, config, mockHost, controller.signal).then(
          () => assert.fail(`${method} must reject after cancellation`),
          (actual) => assert.strictEqual(actual, reason, `${method} must preserve the exact reason`)
        );
        assert.equal(mockHost.calls.length, 0, 'Preflight cancellation must not make requests');
      }
    }
  });

  await test('7.9: Fetch and body cancellation preserve falsy reasons without failover or affinity updates', async () => {
    for (const reason of [false, 0, '', null]) {
      for (const method of ['search', 'resolveFile']) {
        for (const phase of ['fetch-success', 'fetch-error', 'json-success', 'json-error']) {
          const controller = new AbortController();
          const testConfig = { ...config, id: 'falsy-abort-cfg' };
          const key = 'falsy-abort-cfg:12345';
          configAffinity.delete(key);
          const mockHost = createMockHost({
            fetchHandler: async () => {
              if (phase.startsWith('fetch-')) {
                controller.abort(reason);
                if (phase === 'fetch-error') throw new Error('Transport failed after abort');
              }
              return {
                status: 200,
                ok: true,
                headers: { get: () => 'application/json' },
                json: async () => {
                  controller.abort(reason);
                  if (phase === 'json-error') throw new Error('Body failed after abort');
                  return method === 'search' ? { success: true, books: [] } : fileFixture;
                },
              };
            },
          });
          const input = method === 'search'
            ? { query: 'clean code' }
            : { guid: '1234567/b8f4a1', title: 'Clean Code', format: 'epub' };
          await plugin[method](input, testConfig, mockHost, controller.signal).then(
            () => assert.fail(`${method}/${phase} must reject after cancellation`),
            (actual) => assert.strictEqual(actual, reason, `${method}/${phase} must preserve the exact reason`)
          );
          assert.equal(mockHost.calls.length, 1, 'Cancellation must not trigger failover');
          assert.equal(configAffinity.has(key), false, 'Cancellation must not set affinity');
        }
      }
    }
  });
});

// =========================================================================
// Category 8: Candidate Routing & Configuration Affinity
// =========================================================================
await runCategory('8. Candidate Routing & Configuration Affinity', async () => {
  const config = {
    id: 'test-config-1',
    credential: '12345:0123456789abcdef0123456789abcdef',
    baseUrl: 'https://z-library.sk',
    settings: { fallbackMirrors: 'https://1lib.sk' },
  };
  const configKey = 'test-config-1:12345';

  await test('8.1: Search succeeding on fallback Mirror B sets downloadUrl to Mirror B', async () => {
    const mockHost = createMockHost({
      fetchHandler: async (url) => {
        if (url.startsWith('https://z-library.sk')) {
          // Primary times out / network error
          throw new Error('Primary connection failed');
        }
        if (url.startsWith('https://1lib.sk')) {
          return mockResponse({ status: 200, json: searchFixture });
        }
        throw new Error(`Unexpected url: ${url}`);
      },
    });

    const results = await plugin.search({ query: 'architecture' }, config, mockHost);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].downloadUrl.startsWith('https://1lib.sk/eapi/book/1234567/b8f4a1/file'),
      `downloadUrl should carry working fallback mirror: ${results[0].downloadUrl}`
    );
    assert.equal(configAffinity?.get?.(configKey), 'https://1lib.sk');
  });

  await test('8.2: resolveFile routes directly to candidate downloadUrl origin with 1 request', async () => {
    let requestedUrl = null;
    const mockHost = createMockHost({
      fetchHandler: async (url) => {
        requestedUrl = url;
        return mockResponse({ status: 200, json: fileFixture });
      },
    });

    const candidate = {
      guid: '1234567/b8f4a1',
      title: 'Clean Title',
      format: 'epub',
      downloadUrl: 'https://1lib.sk/eapi/book/1234567/b8f4a1/file',
    };

    const resolved = await plugin.resolveFile(candidate, config, mockHost);
    assert.equal(mockHost.calls.length, 1);
    assert.ok(requestedUrl.startsWith('https://1lib.sk/'));
    assert.equal(resolved.url, fileFixture.file.downloadLink);
  });

  await test('8.3: Corrupted downloadUrl falls back to configAffinity', async () => {
    if (setConfigAffinity) {
      setConfigAffinity(configKey, 'https://1lib.sk');
    }

    let requestedUrl = null;
    const mockHost = createMockHost({
      fetchHandler: async (url) => {
        requestedUrl = url;
        return mockResponse({ status: 200, json: fileFixture });
      },
    });

    const corruptedCandidate = {
      guid: '1234567/b8f4a1',
      title: 'Clean Title',
      format: 'epub',
      downloadUrl: 'https://untrusted-attacker.com/malicious/file', // Untrusted
    };

    await plugin.resolveFile(corruptedCandidate, config, mockHost);
    assert.ok(
      requestedUrl.startsWith('https://1lib.sk/'),
      `Should use cached affinity https://1lib.sk instead of untrusted url: ${requestedUrl}`
    );
  });

  await test('8.4: Invalidation: Auth rejection clears configAffinity', async () => {
    if (setConfigAffinity) {
      setConfigAffinity(configKey, 'https://1lib.sk');
    }

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({ status: 401, json: sessionExpiredFixture });
      },
    });

    const candidate = {
      guid: '1234567/b8f4a1',
      title: 'Clean Title',
      format: 'epub',
    };

    await assert.rejects(
      async () => plugin.resolveFile(candidate, config, mockHost),
      (err) => err?.failure === 'unauthorized'
    );

    assert.equal(
      configAffinity?.has?.(configKey),
      false,
      'configAffinity must be invalidated upon 401'
    );
  });

  await test('8.5: Profile authentication rejection in test() clears cached configAffinity', async () => {
    if (setConfigAffinity) {
      setConfigAffinity(configKey, 'https://1lib.sk');
    }
    assert.equal(configAffinity?.get?.(configKey), 'https://1lib.sk');

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 200,
          json: { success: false, message: 'Invalid user key' },
        });
      },
    });

    const res = await plugin.test(config, mockHost);
    assert.equal(res.success, false);
    assert.equal(
      configAffinity?.has?.(configKey),
      false,
      'configAffinity must be invalidated upon JSON auth failure in test()'
    );
  });

  await test('8.6: HTTP 403 JSON authentication failure in test() clears cached configAffinity', async () => {
    if (setConfigAffinity) {
      setConfigAffinity(configKey, 'https://1lib.sk');
    }
    assert.equal(configAffinity?.get?.(configKey), 'https://1lib.sk');

    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 403,
          json: { success: false, message: 'Invalid user key' },
        });
      },
    });

    const res = await plugin.test(config, mockHost);
    assert.equal(res.success, false);
    assert.equal(
      configAffinity?.has?.(configKey),
      false,
      'configAffinity must be invalidated upon HTTP 403 JSON auth failure in test()'
    );
  });
});

// =========================================================================
// Category 9: Fail-Closed Format Settings & Extension Validation
// =========================================================================
await runCategory('9. Fail-Closed Format Settings & Extension Validation', async () => {
  const host = createMockHost();

  await test('9.1: Invalid allowedFormats setting rejected', () => {
    assert.throws(
      () => parseAllowedFormats({ settings: { allowedFormats: 'exe, bat' } }, host),
      (err) => err?.failure === 'error'
    );
    assert.throws(
      () => parseAllowedFormats({ settings: { allowedFormats: 123 } }, host),
      (err) => err?.failure === 'error'
    );

    const valid = parseAllowedFormats({ settings: { allowedFormats: 'epub, pdf' } }, host);
    assert.ok(valid.has('epub') && valid.has('pdf'));
  });

  await test('9.2: Malformed or path-traversing extension in resolveFile rejected', () => {
    assert.throws(
      () => validateAndBuildFileDetails('Clean Architecture', 'Author', 'epub/../../outside', null, host),
      (err) => err?.failure === 'error'
    );
    assert.throws(
      () => validateAndBuildFileDetails('Clean Architecture', 'Author', 'exe', null, host),
      (err) => err?.failure === 'error'
    );
  });

  await test('9.3: 255 UTF-8 bytes filename truncation verified with multi-byte Unicode', () => {
    const multiByteTitle = '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。' +
      '何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。'.repeat(10);

    const details = validateAndBuildFileDetails(multiByteTitle, null, 'epub', null, host);
    const encoder = new TextEncoder();
    const byteLength = encoder.encode(details.fileName).length;

    assert.ok(
      byteLength <= 255,
      `Filename must be <= 255 UTF-8 bytes, got: ${byteLength}`
    );
    assert.ok(
      details.fileName.endsWith('.epub'),
      `Filename must preserve valid extension: ${details.fileName}`
    );
    // Ensure no replacement characters from broken truncation
    assert.ok(
      !details.fileName.includes('\uFFFD'),
      'Filename should not contain replacement character \\uFFFD'
    );
  });

  await test('9.4: Path separators in title cleanly sanitized', () => {
    const details = validateAndBuildFileDetails('Title / With \\ Slashes', null, 'epub', null, host);
    assert.ok(!details.fileName.includes('/'), 'Filename must not contain /');
    assert.ok(!details.fileName.includes('\\'), 'Filename must not contain \\');
    assert.equal(details.format, 'epub');
  });

  await test('9.5: Validates returned file.downloadLink as valid HTTP(S) URL', async () => {
    const config = {
      credential: '12345:0123456789abcdef0123456789abcdef',
      baseUrl: 'https://z-library.sk',
    };

    const invalidLinkMockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 200,
          json: {
            success: true,
            file: {
              downloadLink: 'ftp://insecure.example.com/file.epub',
              extension: 'epub',
            },
          },
        });
      },
    });

    const release = { guid: '1234567/b8f4a1', title: 'Clean Architecture', format: 'epub' };
    await assert.rejects(
      async () => plugin.resolveFile(release, config, invalidLinkMockHost),
      (err) => err?.failure === 'error',
      'Should reject non-HTTP(S) download links'
    );
  });
});

// =========================================================================
// Category 10: Connection Test Strictness
// =========================================================================
await runCategory('10. Connection Test Strictness', async () => {
  const config = {
    id: 'test-config',
    credential: '12345:0123456789abcdef0123456789abcdef',
    baseUrl: 'https://z-library.sk',
  };

  await test('10.1: Invoked with test(config, host) signature (no signal parameter)', async () => {
    assert.equal(plugin.test.length <= 2, true, 'plugin.test should accept config and host');
  });

  await test('10.2: HTTP server failure (e.g. 500) returns { success: false, error: ... }', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({ status: 500, body: 'Internal Server Error' });
      },
    });

    const res = await plugin.test(config, mockHost);
    assert.equal(res.success, false);
    assert.ok(res.error, 'Should contain error description');
  });

  await test('10.3: User ID mismatch returns failure', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 200,
          json: {
            success: true,
            user: { id: 99999, name: 'Other User', email: 'other@example.com' },
          },
        });
      },
    });

    const res = await plugin.test(config, mockHost);
    assert.equal(res.success, false);
    assert.ok(
      /match/i.test(res.error),
      `Should mention ID mismatch: "${res.error}"`
    );
  });

  await test('10.4: Cloudflare challenge HTML returns failure', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 403,
          headers: { 'content-type': 'text/html' },
          body: challengeHtmlFixture,
        });
      },
    });

    const res = await plugin.test(config, mockHost);
    assert.equal(res.success, false);
    assert.ok(/challenge/i.test(res.error));
  });

  await test('10.5: HTTP 401 returns failure', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({
          status: 401,
          json: sessionExpiredFixture,
        });
      },
    });

    const res = await plugin.test(config, mockHost);
    assert.equal(res.success, false);
    assert.ok(/401|credential/i.test(res.error));
  });

  await test('10.6: Successful profile returns { success: true, indexerName: "Z-Library" }', async () => {
    const mockHost = createMockHost({
      fetchHandler: async () => {
        return mockResponse({ status: 200, json: profileFixture });
      },
    });

    const res = await plugin.test(config, mockHost);
    assert.deepEqual(res, { success: true, indexerName: 'Z-Library' });
  });
});

// =========================================================================
// Category 11: Host Contract & Sanitization Lifecycle
// =========================================================================
await runCategory('11. Host Contract & Sanitization Lifecycle', async () => {
  await test('11.1: Plugin exports valid BookOrbit PLUGIN_API_VERSION = 1 shape', () => {
    assert.equal(plugin.apiVersion, 1);
    assert.equal(plugin.version, '0.1.0');
    assert.equal(plugin.type, 'zlibrary');
    assert.equal(plugin.label, 'Z-Library');
    assert.equal(plugin.requiresCredential, true);
    assert.equal(plugin.credentialKind, 'apiKey');
    assert.deepEqual(plugin.mediaKinds, ['ebook']);
    assert.equal(plugin.usesCategories, false);
    assert.equal(plugin.seedsBack, false);
    assert.equal(plugin.defaultBaseUrl, 'https://z-lib.gd');
    assert.ok(typeof plugin.baseUrlHint === 'string');
    assert.ok(Array.isArray(plugin.settingsFields) && plugin.settingsFields.length === 3);
    assert.equal(
      plugin.settingsFields.find(f => f.key === 'fallbackMirrors')?.default,
      'https://z-lib.gl, https://singlelogin.rs, https://zliba.ru'
    );

    assert.equal(typeof plugin.search, 'function');
    assert.equal(typeof plugin.test, 'function');
    assert.equal(typeof plugin.resolveFile, 'function');
  });

  await test('11.2: End-to-end flow: search -> host.sanitizeCandidate -> resolveFile', async () => {
    const config = {
      credential: '12345:0123456789abcdef0123456789abcdef',
      baseUrl: 'https://z-library.sk',
    };

    const mockHost = createMockHost({
      fetchHandler: async (url) => {
        if (url.includes('/eapi/book/search')) {
          return mockResponse({ status: 200, json: searchFixture });
        }
        if (url.includes('/eapi/book/')) {
          return mockResponse({ status: 200, json: fileFixture });
        }
        throw new Error(`Unexpected fetch URL in e2e test: ${url}`);
      },
    });

    // 1. Search
    const searchResults = await plugin.search({ query: 'clean architecture' }, config, mockHost);
    assert.ok(Array.isArray(searchResults) && searchResults.length > 0);
    const candidate = searchResults[0];

    // 2. Host Sanitization (BookOrbit strips internal plugin fields)
    const sanitized = mockHost.sanitizeCandidate(candidate);
    assert.ok(sanitized);
    assert.equal(sanitized.guid, candidate.guid);
    assert.equal(sanitized.title, candidate.title);
    assert.equal(sanitized.downloadUrl, candidate.downloadUrl);

    // 3. Resolve file using sanitized candidate
    const resolved = await plugin.resolveFile(sanitized, config, mockHost);
    assert.ok(resolved);
    assert.equal(resolved.url, fileFixture.file.downloadLink);
    assert.ok(resolved.fileName.endsWith('.epub'));
    assert.equal(resolved.format, 'epub');
    assert.equal(resolved.sizeBytes, fileFixture.file.filesize);
  });

  await test('11.3: BookOrbit host loader validation rules verification', () => {
    // Validate BookOrbit host loader schema requirements:
    assert.equal(plugin.apiVersion, 1, 'Host requires apiVersion === 1');
    assert.match(plugin.type, /^[a-z0-9_-]+$/, 'Plugin type must be valid identifier');
    assert.ok(typeof plugin.label === 'string' && plugin.label.length > 0, 'Plugin label must be non-empty');
    assert.match(plugin.version, /^\d+\.\d+\.\d+/, 'Plugin version must follow semver');
    assert.equal(typeof plugin.requiresCredential, 'boolean');
    assert.ok(['apiKey', 'basic', 'sessionCookie', 'oauth'].includes(plugin.credentialKind));
    assert.ok(Array.isArray(plugin.mediaKinds) && plugin.mediaKinds.every(k => ['ebook', 'audiobook', 'comic'].includes(k)));
    assert.equal(typeof plugin.usesCategories, 'boolean');
    assert.equal(typeof plugin.seedsBack, 'boolean');

    const defaultUrl = new URL(plugin.defaultBaseUrl);
    assert.equal(defaultUrl.protocol, 'https:', 'defaultBaseUrl must be https');

    for (const field of plugin.settingsFields) {
      assert.ok(typeof field.key === 'string' && field.key.length > 0);
      assert.ok(['string', 'number', 'boolean'].includes(field.type));
      assert.ok(typeof field.label === 'string');
      assert.ok(field.default !== undefined);
    }

    // Function parameter counts per host contract
    assert.ok(plugin.search.length >= 3, 'search() requires (query, config, host, signal)');
    assert.ok(plugin.test.length <= 2, 'test() host contract forbids signal argument');
    assert.ok(plugin.resolveFile.length >= 3, 'resolveFile() requires (release, config, host, signal)');
  });

  await test('11.4: Strict BookOrbit release candidate and resolveFile return schema contract', async () => {
    const config = {
      credential: '12345:0123456789abcdef0123456789abcdef',
      baseUrl: 'https://z-library.sk',
    };

    const mockHost = createMockHost({
      fetchHandler: async (url) => {
        if (url.includes('/eapi/book/search')) return mockResponse({ status: 200, json: searchFixture });
        if (url.includes('/eapi/book/')) return mockResponse({ status: 200, json: fileFixture });
        throw new Error(`Unexpected url: ${url}`);
      },
    });

    const candidates = await plugin.search({ query: 'clean code' }, config, mockHost);
    for (const c of candidates) {
      // Validate candidate release contract
      assert.match(c.guid, /^\d{1,20}\/[a-zA-Z0-9_-]{1,32}$/, 'guid must match bounded schema');
      assert.ok(typeof c.title === 'string' && c.title.length > 0, 'title must be non-empty string');
      assert.ok(typeof c.bookTitle === 'string' && c.bookTitle.length > 0, 'bookTitle must be non-empty string');
      assert.ok(new URL(c.downloadUrl).protocol === 'https:', 'downloadUrl must be https URL');
      assert.ok(typeof c.format === 'string' && /^[a-z0-9]+$/.test(c.format), 'format must be clean string');
      assert.ok(c.sizeBytes === null || (typeof c.sizeBytes === 'number' && c.sizeBytes >= 0), 'sizeBytes must be positive or null');
      assert.equal(c.freeleech, true);
      assert.equal(c.primaryFileCount, 1);
    }

    const resolved = await plugin.resolveFile(candidates[0], config, mockHost);
    assert.ok(new URL(resolved.url).protocol.startsWith('http'), 'resolved url must be valid HTTP(S)');
    assert.ok(typeof resolved.fileName === 'string' && resolved.fileName.length > 0, 'fileName must be non-empty');
    assert.ok(!/[/\\]/.test(resolved.fileName), 'fileName must not contain path separators');
    assert.ok(new TextEncoder().encode(resolved.fileName).length <= 255, 'fileName must be <= 255 UTF-8 bytes');
    assert.ok(resolved.fileName.endsWith(`.${resolved.format}`), 'fileName extension must match format');
    assert.ok(typeof resolved.format === 'string');
    assert.ok(typeof resolved.sizeBytes === 'number' && resolved.sizeBytes >= 0);
  });
});

await test('Connection test suppresses secret-bearing transport diagnostics across fallbacks', async () => {
  const config = { credential: '12345:0123456789abcdef0123456789abcdef', baseUrl: 'https://z-library.sk',
    settings: { fallbackMirrors: 'https://mirror.example' } };
  const host = createMockHost({ fetchHandler: async () => {
    throw new Error('Cookie: remix_userkey=FAKE_SECRET /private/staging https://mirror.example/file?cap=FAKE_CAP');
  } });
  const result = await plugin.test(config, host);
  assert.equal(result.success, false);
  assert.equal(result.error, 'Could not contact Z-Library mirror or read its response');
  assert.equal(host.calls.length, 2);
});

// =========================================================================
// Test Summary & Exit Code
// =========================================================================
console.log(`\n============================================================`);
console.log(` VERIFICATION SUMMARY`);
console.log(`============================================================`);
console.log(` Total tests run : ${passedTests + failedTests}`);
console.log(` Passed          : ${passedTests}`);
console.log(` Failed          : ${failedTests}`);

if (failedTests > 0) {
  console.error(`\nFailures detected:`);
  for (const { description, err } of failures) {
    console.error(` - ${description}: ${err?.message || err}`);
  }
  process.exitCode = 1;
} else {
  console.log(`\nAll 11 verification categories PASSED successfully!`);
  process.exitCode = 0;
}
