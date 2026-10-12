/**
 * BookOrbit Z-Library Indexer Plugin
 *
 * Implements BookOrbit PLUGIN_API_VERSION = 1 indexer plugin contract
 * for authenticated Z-Library search and download resolution.
 */

// Bounded authentication schema
const USER_ID_REGEX = /^\d+$/;
const USER_KEY_REGEX = /^[a-fA-F0-9]{32}$/;

// Bounded book identity schemas compatible with host limits
const BOOK_ID_REGEX = /^\d{1,20}$/;
const BOOK_HASH_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;

// Host & mirror trust configuration
const DEFAULT_FALLBACK_MIRRORS = ['https://z-lib.gl', 'https://singlelogin.rs', 'https://zliba.ru'];
const BARE_HOST_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[0-9]{1,5})?$/;

const SUPPORTED_EBOOK_FORMATS = new Set([
  'epub', 'mobi', 'pdf', 'azw3', 'fb2', 'djvu', 'txt', 'rtf',
]);

const MAX_AFFINITY_ENTRIES = 50;
const MAX_FILENAME_BYTES = 255;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Configuration-scoped working mirror cache: configKey -> origin (bounded LRU map)
const configAffinity = new Map();

function setConfigAffinity(key, mirror) {
  if (configAffinity.has(key)) {
    configAffinity.delete(key);
  } else if (configAffinity.size >= MAX_AFFINITY_ENTRIES) {
    const oldestKey = configAffinity.keys().next().value;
    if (oldestKey !== undefined) {
      configAffinity.delete(oldestKey);
    }
  }
  configAffinity.set(key, mirror);
}

/**
 * Validates a book's ID and hash independently from account credentials.
 */
function validateBookIdentity(id, hash) {
  const idStr = id != null ? String(id).trim() : '';
  const hashStr = typeof hash === 'string' ? hash.trim() : '';
  return BOOK_ID_REGEX.test(idStr) && BOOK_HASH_REGEX.test(hashStr);
}

/**
 * Parses release GUID into exactly two validated components: bookId and bookHash.
 * Rejects trailing or missing components.
 */
function parseBookGuid(guid) {
  if (typeof guid !== 'string') return null;
  const parts = guid.split('/');
  if (parts.length !== 2) return null;
  const [bookId, bookHash] = parts;
  if (!validateBookIdentity(bookId, bookHash)) return null;
  return { bookId: bookId.trim(), bookHash: bookHash.trim() };
}

/**
 * Parses and validates credentials from config.credential string.
 * Supported formats:
 * - "<userid>:<userkey>" or "<userid>/<userkey>"
 * - JSON: '{"userid": "...", "userkey": "..."}' (including remix_userid / remixUserid variants)
 * - Auto-swaps if 32-hex key and numeric ID are inverted
 */
function parseAndValidateCredential(config, host) {
  const raw = config?.credential ?? config?.apiKey;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    throw host.fail(
      'unauthorized',
      'Z-Library credentials required. Enter as "<userid>:<userkey>" in plugin credentials.'
    );
  }

  let userid = '';
  let userkey = '';
  const trimmed = raw.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      userid = String(parsed.userid ?? parsed.remix_userid ?? parsed.remixUserid ?? '').trim();
      userkey = String(parsed.userkey ?? parsed.remix_userkey ?? parsed.remixUserkey ?? '').trim();
    } catch {
      // Fall through to delimiter parsing
    }
  }

  if (!userid || !userkey) {
    const separator = trimmed.includes(':') ? ':' : trimmed.includes('/') ? '/' : null;
    if (separator) {
      const parts = trimmed.split(separator);
      userid = parts[0].trim();
      userkey = parts.slice(1).join(separator).trim();
    }
  }

  // Auto-swap heuristic: if userid is 32-hex and userkey is numeric digits
  if (USER_KEY_REGEX.test(userid) && USER_ID_REGEX.test(userkey)) {
    const temp = userid;
    userid = userkey;
    userkey = temp;
  }

  if (!userid || !userkey || !USER_ID_REGEX.test(userid) || !USER_KEY_REGEX.test(userkey)) {
    throw host.fail(
      'unauthorized',
      'Invalid credential format. Expected numeric user ID and 32-character hex user key ("<userid>:<userkey>").'
    );
  }

  return { userid, userkey };
}

function buildCookieHeader(userid, userkey) {
  return `remix_userid=${userid}; remix_userkey=${userkey}; siteLanguageV2=en`;
}

/**
 * Validates, normalizes, and secures HTTPS mirror origins.
 * Rejects non-HTTPS schemes, userinfo, path spoofing, invalid ports.
 * Normalizes bare hostnames and port 443.
 */
function sanitizeHttpsOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const str = raw.trim();

  // Explicit scheme check:
  if (str.includes('://')) {
    if (!str.toLowerCase().startsWith('https://')) {
      return null; // Reject http://, ftp://, etc.
    }
    try {
      const u = new URL(str);
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
      if (u.pathname.startsWith('//')) return null;
      return u.origin;
    } catch {
      return null;
    }
  }

  // Bare hostname: must not contain slashes, query strings, or fragments
  if (/[/?#\\]/.test(str)) return null;
  if (!BARE_HOST_REGEX.test(str)) return null;

  const [hostPart, portPart] = str.split(':');
  if (!hostPart.includes('.') && hostPart !== 'localhost') return null;
  if (portPart) {
    const portNum = Number(portPart);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
  }

  try {
    const u = new URL(`https://${str}`);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Resolves verified trusted mirror list starting with validated primary mirror.
 * Respects fallbackMirrors setting and maxMirrorAttempts constraint.
 */
function trustedMirrors(config, host) {
  const rawPrimary = config?.baseUrl || 'https://z-lib.gd';
  const primary = sanitizeHttpsOrigin(rawPrimary);
  if (!primary) {
    throw host.fail('error', 'Invalid primary Z-Library mirror URL. Must be a valid HTTPS domain.');
  }

  const mirrors = [primary];
  const fallbackSetting = config?.settings?.fallbackMirrors;

  if (fallbackSetting !== undefined) {
    if (typeof fallbackSetting === 'string' && fallbackSetting.trim() !== '') {
      for (const part of fallbackSetting.split(',')) {
        const origin = sanitizeHttpsOrigin(part);
        if (origin && !mirrors.includes(origin)) {
          mirrors.push(origin);
        }
      }
    }
    // If fallbackSetting is empty string "", zero fallback mirrors are added
  } else {
    for (const def of DEFAULT_FALLBACK_MIRRORS) {
      const origin = sanitizeHttpsOrigin(def);
      if (origin && !mirrors.includes(origin)) {
        mirrors.push(origin);
      }
    }
  }

  const rawMax = Number(config?.settings?.maxMirrorAttempts);
  const maxAttempts = Number.isInteger(rawMax) ? Math.min(Math.max(1, rawMax), 10) : 3;
  return mirrors.slice(0, maxAttempts);
}

/**
 * Classifies a parsed JSON response envelope.
 * Strictly requires data.success === true. If false or missing, throws the appropriate host failure.
 */
function classifyApiEnvelope(data, host, context = 'API') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const err = new Error(`Z-Library ${context} returned invalid non-object payload`);
    err.isEnvelopeError = true;
    throw err;
  }

  const isSuccess = data.success === true || data.success === 1 || data.success === '1';
  if (!isSuccess) {
    const rawError = String(data.error || data.message || '').trim().toLowerCase();

    // 1. Authentication rejection
    if (
      (rawError.includes('invalid') && (rawError.includes('user') || rawError.includes('key') || rawError.includes('remix'))) ||
      rawError.includes('auth') ||
      rawError.includes('unauthorized') ||
      rawError.includes('login required') ||
      rawError.includes('session expired')
    ) {
      throw host.fail('unauthorized', 'Z-Library rejected credentials — check remix_userid and remix_userkey');
    }

    // 2. Daily download quota exhaustion
    if (
      rawError.includes('daily limit') ||
      rawError.includes('download limit') ||
      rawError.includes('quota exceeded') ||
      rawError.includes('limit reached') ||
      rawError.includes('too many requests')
    ) {
      throw host.fail('throttled', 'Z-Library daily download limit reached for this account');
    }

    // 3. Other application-level error
    const err = new Error(`Z-Library ${context} request failed`);
    err.isEnvelopeError = true;
    throw err;
  }

  return data;
}

/**
 * Parses and validates configured ebook format extensions against SUPPORTED_EBOOK_FORMATS.
 */
function parseAllowedFormats(config, host) {
  const raw = config?.settings?.allowedFormats;
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return new Set(['epub', 'mobi', 'pdf', 'azw3']);
  }

  if (typeof raw !== 'string') {
    throw host.fail('error', 'Invalid allowedFormats configuration setting: expected string');
  }

  const configured = raw
    .split(',')
    .map(ext => ext.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);

  const allowed = new Set();
  for (const ext of configured) {
    if (SUPPORTED_EBOOK_FORMATS.has(ext)) {
      allowed.add(ext);
    }
  }

  if (allowed.size === 0) {
    throw host.fail('error', 'No valid formats specified in allowedFormats setting');
  }

  return allowed;
}

function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}

function truncateUtf8(str, maxBytes) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const bytes = encoder.encode(str);
  if (bytes.length <= maxBytes) return str;
  return decoder.decode(bytes.slice(0, maxBytes)).replace(/\uFFFD+$/, '');
}

function sanitizeBaseName(name) {
  if (!name || typeof name !== 'string') return 'download';
  const cleaned = name
    .normalize('NFC')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/[/\\]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/[^\p{L}\p{N}\s._\-()]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'download';
}

/**
 * Validates extension strictly (fail-closed) and builds a safe, bounded filename <= 255 UTF-8 bytes.
 */
function validateAndBuildFileDetails(description, author, rawExt, fallbackFormat, host) {
  let ext = '';
  if (typeof rawExt === 'string' && rawExt.trim()) {
    ext = rawExt.trim().toLowerCase().replace(/^\.+/, '');
  } else if (rawExt == null && typeof fallbackFormat === 'string' && fallbackFormat.trim()) {
    ext = fallbackFormat.trim().toLowerCase().replace(/^\.+/, '');
  }

  if (!ext || !SUPPORTED_EBOOK_FORMATS.has(ext) || !/^[a-z0-9]+$/.test(ext)) {
    throw host.fail('error', 'Z-Library returned unsupported or malformed file extension');
  }

  const combined = author ? `${description} (${author})` : description;
  let baseName = sanitizeBaseName(combined);

  const extBytes = utf8ByteLength(ext);
  const maxBaseBytes = MAX_FILENAME_BYTES - 1 - extBytes;
  if (utf8ByteLength(baseName) > maxBaseBytes) {
    baseName = truncateUtf8(baseName, maxBaseBytes).trim() || 'download';
  }

  const fileName = `${baseName}.${ext}`;
  if (fileName.includes('/') || fileName.includes('\\')) {
    throw host.fail('error', 'Filename validation encountered unexpected path separator');
  }

  return { fileName, format: ext };
}

/**
 * Converts a raw book record from Z-Library into a BookOrbit Candidate Release.
 */
function toCandidateRelease(book, allowedFormats, workingMirror) {
  const id = book.id != null ? String(book.id).trim() : '';
  const hash = typeof book.hash === 'string' ? book.hash.trim() : '';

  // Validate GUID components strictly at search time
  if (!validateBookIdentity(id, hash)) return null;

  const title = typeof book.title === 'string' ? book.title.trim() : '';
  const rawExt = typeof book.extension === 'string' ? book.extension.trim().toLowerCase() : '';

  if (!title || !rawExt || !allowedFormats.has(rawExt)) return null;

  const size = typeof book.filesize === 'number' && Number.isFinite(book.filesize) && book.filesize >= 0
    ? book.filesize
    : null;
  const author = typeof book.author === 'string' && book.author.trim() ? book.author.trim() : undefined;
  const language = typeof book.language === 'string' && book.language.trim()
    ? book.language.trim().toLowerCase()
    : undefined;

  return {
    guid: `${id}/${hash}`,
    title,
    bookTitle: title,
    // Store verified working endpoint in downloadUrl (retained by host sanitization)
    downloadUrl: `${workingMirror}/eapi/book/${id}/${hash}/file`,
    sizeBytes: size,
    seeders: null,
    leechers: null,
    format: rawExt,
    ...(author ? { author } : {}),
    ...(language ? { language } : {}),
    freeleech: true,
    primaryFileCount: 1,
  };
}

/**
 * Searches Z-Library catalog across trusted mirrors.
 */
async function search(query, config, host, signal) {
  if (signal?.aborted) {
    throw signal.reason;
  }

  const searchText = (
    typeof host?.buildSearchText === 'function'
      ? host.buildSearchText(query)
      : (typeof query === 'string' ? query : query?.query || query?.title || '')
  )?.trim();
  if (!searchText) return [];

  const { userid, userkey } = parseAndValidateCredential(config, host);
  const cookieHeader = buildCookieHeader(userid, userkey);
  const mirrors = trustedMirrors(config, host);
  const allowedFormats = parseAllowedFormats(config, host);
  const requestedLimit = typeof query?.limit === 'number' && Number.isFinite(query.limit)
    ? query.limit
    : 25;
  const limit = Math.min(Math.max(1, requestedLimit), 50);
  const configKey = `${config?.id || 'default'}:${userid}`;

  const body = new URLSearchParams();
  body.set('message', searchText);
  for (const ext of allowedFormats) {
    body.append('extensions[]', ext);
  }
  body.set('limit', String(limit));

  let sawThrottled = false;
  let sawTimeout = false;
  let sawMalformed = false;
  let sawNetworkError = false;

  for (const mirror of mirrors) {
    if (signal?.aborted) {
      throw signal.reason;
    }

    try {
      const url = `${mirror}/eapi/book/search`;
      const response = await host.fetch(url, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieHeader,
        },
        body: body.toString(),
        ...(signal ? { signal } : {}),
      });

      if (signal?.aborted) {
        throw signal.reason;
      }

      // Explicit status precedence: HTTP 401 is always authentication failure
      if (response.status === 401) {
        configAffinity.delete(configKey);
        throw host.fail('unauthorized', 'Z-Library rejected credentials (HTTP 401)');
      }

      if (response.status === 429) {
        sawThrottled = true;
        continue;
      }

      const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();

      // Cloudflare / WAF challenge detection on 403, 503, or 200 HTML:
      if (contentType.includes('text/html') && (response.status === 403 || response.status === 503 || response.status === 200)) {
        continue;
      }

      // Parse JSON before evaluating !response.ok so JSON 403 auth errors are classified
      let data = null;
      try {
        data = await response.json();
      } catch (err) {
        if (signal?.aborted) {
          throw signal.reason;
        }
        sawMalformed = true;
        continue;
      }

      if (signal?.aborted) {
        throw signal.reason;
      }

      // Classifies envelopes: strictly requires data.success === true
      try {
        classifyApiEnvelope(data, host, 'search');
      } catch (classifyErr) {
        if (classifyErr?.failure === 'unauthorized') {
          configAffinity.delete(configKey);
          throw classifyErr;
        }
        if (classifyErr?.failure === 'throttled') {
          throw classifyErr;
        }
        if (classifyErr?.isEnvelopeError) {
          sawMalformed = true;
          continue;
        }
        throw classifyErr;
      }

      if (!response.ok) {
        sawMalformed = true;
        continue;
      }

      if (!Array.isArray(data.books)) {
        sawMalformed = true;
        continue;
      }

      if (signal?.aborted) {
        throw signal.reason;
      }

      // Record working mirror affinity
      setConfigAffinity(configKey, mirror);

      if (data.books.length === 0) {
        return []; // Verified empty catalog
      }

      if (signal?.aborted) {
        throw signal.reason;
      }

      const releases = [];
      for (const b of data.books) {
        if (!b || typeof b !== 'object') continue;
        const release = toCandidateRelease(b, allowedFormats, mirror);
        if (release) releases.push(release);
        if (releases.length >= limit) break;
      }

      return releases;
    } catch (err) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      if (err?.failure === 'unauthorized' || err?.failure === 'throttled') {
        throw err;
      }
      if (err?.name === 'TimeoutError' || /timeout/i.test(err?.message || '')) {
        sawTimeout = true;
      } else {
        sawNetworkError = true;
      }
    }
  }

  if (signal?.aborted) {
    throw signal.reason;
  }
  if (sawThrottled && !sawMalformed && !sawNetworkError && !sawTimeout) {
    throw host.fail('throttled', 'All Z-Library mirrors reported rate limiting');
  }
  if (sawTimeout && !sawMalformed && !sawNetworkError && !sawThrottled) {
    throw host.fail('timeout', 'All Z-Library mirrors timed out');
  }
  if (sawMalformed && !sawNetworkError && !sawTimeout && !sawThrottled) {
    throw host.fail('error', 'All Z-Library mirrors returned invalid API responses');
  }
  throw host.fail(sawNetworkError ? 'unreachable' : 'error', 'No usable response from Z-Library mirrors');
}

/**
 * Validates connection and account credentials against primary mirror.
 * Note: test takes NO signal argument per host contract.
 */
async function test(config, host) {
  let userid, userkey;
  try {
    const creds = parseAndValidateCredential(config, host);
    userid = creds.userid;
    userkey = creds.userkey;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let mirrors;
  try {
    mirrors = trustedMirrors(config, host);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const configKey = `${config?.id || 'default'}:${userid}`;
  const cookieHeader = buildCookieHeader(userid, userkey);
  let lastError = 'No mirrors available';

  for (const mirror of mirrors) {
    try {
      const response = await host.fetch(`${mirror}/eapi/user/profile`, {
        method: 'GET',
        headers: {
          ...BROWSER_HEADERS,
          Cookie: cookieHeader,
        },
      });

      if (response.status === 401) {
        configAffinity.delete(configKey);
        return { success: false, error: 'Z-Library rejected credentials (HTTP 401)' };
      }

      const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        lastError = 'Mirror returned Cloudflare/WAF challenge';
        continue;
      }

      let data;
      try {
        data = await response.json();
      } catch {
        lastError = 'Invalid JSON response from mirror';
        continue;
      }

      try {
        classifyApiEnvelope(data, host, 'test');
      } catch (classifyErr) {
        if (classifyErr?.failure === 'unauthorized') {
          configAffinity.delete(configKey);
          return {
            success: false,
            error: classifyErr instanceof Error ? classifyErr.message : String(classifyErr),
          };
        }
        lastError = classifyErr instanceof Error ? classifyErr.message : String(classifyErr);
        continue;
      }

      if (!response.ok) {
        lastError = `HTTP ${response.status} from mirror`;
        continue;
      }

      const user = data.user;
      if (!user || typeof user !== 'object' || user.id == null) {
        lastError = 'Z-Library profile did not contain authenticated user data';
        continue;
      }

      if (String(user.id).trim() !== String(userid).trim()) {
        configAffinity.delete(configKey);
        return { success: false, error: 'Authenticated user ID does not match configured credentials' };
      }

      setConfigAffinity(configKey, mirror);
      return { success: true, indexerName: 'Z-Library' };
    } catch (err) {
      if (err?.failure === 'unauthorized') {
        configAffinity.delete(configKey);
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      lastError = 'Could not contact Z-Library mirror or read its response';
      continue;
    }
  }

  return { success: false, error: lastError };
}

/**
 * Resolves verified download ticket and builds bounded release file details.
 */
async function resolveFile(release, config, host, signal) {
  if (signal?.aborted) {
    throw signal.reason;
  }

  const parsedGuid = parseBookGuid(release?.guid);
  if (!parsedGuid) {
    throw host.fail('error', 'Invalid release GUID format: expected "<id>/<hash>"');
  }
  const { bookId, bookHash } = parsedGuid;

  const { userid, userkey } = parseAndValidateCredential(config, host);
  const cookieHeader = buildCookieHeader(userid, userkey);
  const mirrors = trustedMirrors(config, host);
  const configKey = `${config?.id || 'default'}:${userid}`;

  // Evaluate candidate routes independently:
  let chosenMirror = null;
  if (release?.downloadUrl && typeof release.downloadUrl === 'string') {
    try {
      const u = new URL(release.downloadUrl);
      if (u.protocol === 'https:' && mirrors.includes(u.origin)) {
        chosenMirror = u.origin;
      }
    } catch {}
  }

  if (!chosenMirror && configAffinity.has(configKey)) {
    const cached = configAffinity.get(configKey);
    if (mirrors.includes(cached)) {
      chosenMirror = cached;
    }
  }

  if (!chosenMirror) {
    chosenMirror = mirrors[0];
  }

  const fileUrl = `${chosenMirror}/eapi/book/${encodeURIComponent(bookId)}/${encodeURIComponent(bookHash)}/file`;
  let response;

  try {
    response = await host.fetch(fileUrl, {
      method: 'GET',
      headers: {
        ...BROWSER_HEADERS,
        Cookie: cookieHeader,
      },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (err?.name === 'TimeoutError' || /timeout/i.test(err?.message || '')) {
      throw host.fail('timeout', 'Z-Library file endpoint timed out');
    }
    throw host.fail('unreachable', 'Could not reach Z-Library file endpoint');
  }

  if (signal?.aborted) {
    throw signal.reason;
  }

  // Precedence: HTTP 401 is always authentication failure
  if (response.status === 401) {
    configAffinity.delete(configKey);
    throw host.fail('unauthorized', 'Z-Library rejected credentials (HTTP 401)');
  }

  if (response.status === 429) {
    throw host.fail('throttled', 'Z-Library rate limited download resolution');
  }

  const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw host.fail('unreachable', 'Mirror returned HTML challenge during file resolution');
  }

  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw host.fail('error', 'Z-Library file endpoint returned invalid JSON');
  }

  if (signal?.aborted) {
    throw signal.reason;
  }

  // Strictly classify envelope (throws unauthorized or throttled if failure)
  try {
    classifyApiEnvelope(data, host, 'resolveFile');
  } catch (classifyErr) {
    if (classifyErr?.failure === 'unauthorized') {
      configAffinity.delete(configKey);
      throw classifyErr;
    }
    if (classifyErr?.failure === 'throttled') {
      throw classifyErr;
    }
    if (classifyErr?.isEnvelopeError || !classifyErr?.failure) {
      throw host.fail('error', classifyErr?.message || 'Z-Library file endpoint returned invalid API response');
    }
    throw classifyErr;
  }

  if (!response.ok) {
    throw host.fail('error', `Z-Library file endpoint returned HTTP ${response.status}`);
  }

  if (!data?.file || typeof data.file !== 'object' || typeof data.file.downloadLink !== 'string') {
    throw host.fail('error', 'Z-Library offered no valid download link for this book');
  }

  // Validate download URL
  const rawDownloadLink = data.file.downloadLink.trim();
  let validatedDownloadUrl;
  try {
    const parsedUrl = new URL(rawDownloadLink);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Unsupported protocol');
    }
    validatedDownloadUrl = parsedUrl.toString();
  } catch {
    throw host.fail('error', 'Z-Library returned an invalid download URL');
  }

  const file = data.file;
  const description = file.description || release.bookTitle || release.title || 'download';
  const author = file.author || release.author;

  const { fileName, format } = validateAndBuildFileDetails(
    description,
    author,
    file.extension,
    release.format,
    host
  );

  const sizeBytes = typeof file.filesize === 'number' && Number.isFinite(file.filesize) && file.filesize >= 0
    ? file.filesize
    : release.sizeBytes;

  return {
    url: validatedDownloadUrl,
    fileName,
    sizeBytes,
    format,
  };
}

const plugin = {
  apiVersion: 1,
  version: '0.1.0',
  type: 'zlibrary',
  label: 'Z-Library',
  requiresCredential: true,
  credentialKind: 'apiKey',
  mediaKinds: ['ebook'],
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'https://z-lib.gd',
  baseUrlHint: 'Primary HTTPS Z-Library mirror URL (e.g. https://z-lib.gd or https://z-lib.gl).',
  settingsFields: [
    {
      key: 'fallbackMirrors',
      type: 'string',
      label: 'Fallback mirrors (comma-separated)',
      hint: 'Additional HTTPS mirrors tried in order if primary fails. Leave blank to disable fallbacks.',
      default: 'https://z-lib.gl, https://singlelogin.rs, https://zliba.ru',
    },
    {
      key: 'allowedFormats',
      type: 'string',
      label: 'Allowed formats (comma-separated)',
      hint: 'Ebook formats accepted from search results (e.g. epub, mobi, pdf, azw3).',
      default: 'epub, mobi, pdf, azw3',
    },
    {
      key: 'maxMirrorAttempts',
      type: 'number',
      label: 'Maximum mirror attempts',
      hint: 'Maximum mirrors to try per search request (1 to 10).',
      default: 3,
    },
  ],
  search,
  test,
  resolveFile,
  _internals: {
    parseAndValidateCredential,
    sanitizeHttpsOrigin,
    trustedMirrors,
    classifyApiEnvelope,
    parseBookGuid,
    validateBookIdentity,
    validateAndBuildFileDetails,
    parseAllowedFormats,
    configAffinity,
    setConfigAffinity,
    truncateUtf8,
    sanitizeBaseName,
    toCandidateRelease,
    buildCookieHeader,
    DEFAULT_FALLBACK_MIRRORS,
    SUPPORTED_EBOOK_FORMATS,
  },
};

export default plugin;

export {
  parseAndValidateCredential,
  sanitizeHttpsOrigin,
  trustedMirrors,
  classifyApiEnvelope,
  parseBookGuid,
  validateBookIdentity,
  validateAndBuildFileDetails,
  parseAllowedFormats,
  configAffinity,
  setConfigAffinity,
  truncateUtf8,
  sanitizeBaseName,
  toCandidateRelease,
  buildCookieHeader,
  DEFAULT_FALLBACK_MIRRORS,
  SUPPORTED_EBOOK_FORMATS,
  search,
  test,
  resolveFile,
};
