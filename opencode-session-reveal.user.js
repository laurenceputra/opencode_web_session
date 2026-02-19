// ==UserScript==
// @name         OpenCode Session Reveal Overlay
// @namespace    https://github.com/opencode/session-reveal
// @version      1.0.0
// @description  Discover and reveal OpenCode sessions through an in-page overlay.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // User-editable defaults (kept near top intentionally).
  // - Set allowedAppHosts to an explicit list (["app.example.com"]) to only run on those hosts.
  // - Leave allowedAppHosts empty to allow any host matched by @match.
  // - Set defaultOpencodeBaseUrl when API host differs from current page origin.
  const USER_CONFIG = Object.freeze({
    allowedAppHosts: [],
    defaultOpencodeBaseUrl: '',
    defaultDirectory: '',
    defaultBasicAuthUsername: '',
    defaultBasicAuthPassword: '',
  });

  const STORAGE_NAMESPACE = 'opencodeSessionReveal.v1';
  const STORAGE_KEY_CONFIG = `${STORAGE_NAMESPACE}.config`;
  const LEGACY_CONFIG_KEYS = ['opencodeSessionRevealConfig', 'opencodeSessionImportConfig'];
  const REQUEST_TIMEOUT_MS = 15000;
  const DEFAULT_LIST_LIMIT = 100;

  const DEFAULT_CONFIG = Object.freeze({
    opencodeBaseUrl: normalizeString(USER_CONFIG.defaultOpencodeBaseUrl),
    directory: normalizeString(USER_CONFIG.defaultDirectory),
    basicAuthUsername: normalizeString(USER_CONFIG.defaultBasicAuthUsername),
    basicAuthPassword:
      normalizeString(USER_CONFIG.defaultBasicAuthUsername) &&
      typeof USER_CONFIG.defaultBasicAuthPassword === 'string'
        ? USER_CONFIG.defaultBasicAuthPassword
        : '',
  });

  const state = {
    config: loadConfig(),
    overlayVisible: false,
    loadingSessions: false,
    sessions: [],
    malformedCount: 0,
    duplicateCount: 0,
    searchTerm: '',
    showArchived: false,
    bulkScope: 'filtered',
    rowStatusById: new Map(),
    runState: {
      inProgress: false,
      mode: null,
      processed: 0,
      total: 0,
      revealed: 0,
      warning: 0,
      failed: 0,
    },
    listMessage: '',
    listMessageKind: 'info',
    lastRefreshAt: 0,
  };

  const ui = {
    mounted: false,
    root: null,
    refreshButton: null,
    importAllButton: null,
    settingsButton: null,
    closeButton: null,
    bulkScopeSelect: null,
    showArchivedCheckbox: null,
    searchInput: null,
    rowsBody: null,
    noticeLine: null,
    pipelineLine: null,
    progressLine: null,
    summaryLine: null,
    countLine: null,
    launcherButton: null,
  };

  class ConfigError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ConfigError';
    }
  }

  class NetworkRequestError extends Error {
    constructor(message) {
      super(message);
      this.name = 'NetworkRequestError';
    }
  }

  class HttpRequestError extends Error {
    constructor(status, message) {
      super(message);
      this.name = 'HttpRequestError';
      this.status = status;
    }
  }

  class ResponseShapeError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ResponseShapeError';
    }
  }

  function init() {
    if (window.top !== window.self) {
      return;
    }
    if (!isAllowedCurrentHost()) {
      return;
    }

    injectStyles();
    mountOverlay();
    mountLauncher();
    registerMenuCommands();
    render();
  }

  function gmGetValue(key, fallbackValue) {
    if (typeof GM_getValue !== 'function') {
      return fallbackValue;
    }
    return GM_getValue(key, fallbackValue);
  }

  function gmSetValue(key, value) {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, value);
    }
  }

  function gmRegisterMenuCommand(label, action) {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand(label, action);
    }
  }

  function normalizedAllowedHosts() {
    if (!Array.isArray(USER_CONFIG.allowedAppHosts)) {
      return [];
    }
    return USER_CONFIG.allowedAppHosts
      .map((entry) => normalizeString(entry).toLowerCase())
      .filter(Boolean);
  }

  function isAllowedCurrentHost() {
    const allowedHosts = normalizedAllowedHosts();
    if (allowedHosts.length === 0) {
      return true;
    }
    const currentHost = normalizeString(window.location.host).toLowerCase();
    return allowedHosts.includes(currentHost);
  }

  function detectDefaultBaseUrl() {
    if (normalizeString(USER_CONFIG.defaultOpencodeBaseUrl)) {
      try {
        return validateBaseUrl(USER_CONFIG.defaultOpencodeBaseUrl);
      } catch (_error) {
        // Fall through to current origin if the optional default is invalid.
      }
    }
    return `${window.location.protocol}//${window.location.host}`;
  }

  function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function validateBaseUrl(baseUrl) {
    const candidate = normalizeString(baseUrl);
    if (!candidate) {
      throw new ConfigError('OpenCode base URL is required.');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(candidate);
    } catch (_error) {
      throw new ConfigError('OpenCode base URL must be a valid http(s) URL.');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new ConfigError('OpenCode base URL must start with http:// or https://.');
    }

    parsedUrl.hash = '';
    parsedUrl.search = '';
    return parsedUrl.href.replace(/\/+$/, '');
  }

  function normalizeConfig(rawConfig, strictValidation) {
    const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    const rawBaseUrl = normalizeString(raw.opencodeBaseUrl);
    const hasBaseUrl = rawBaseUrl.length > 0;

    let normalizedBaseUrl = '';
    if (hasBaseUrl) {
      try {
        normalizedBaseUrl = validateBaseUrl(rawBaseUrl);
      } catch (error) {
        if (strictValidation) {
          throw error;
        }
        normalizedBaseUrl = '';
      }
    } else if (!strictValidation) {
      normalizedBaseUrl = detectDefaultBaseUrl();
    }

    const normalizedUsername = normalizeString(raw.basicAuthUsername);
    const normalizedPassword =
      typeof raw.basicAuthPassword === 'string' ? raw.basicAuthPassword : '';

    return {
      opencodeBaseUrl: normalizedBaseUrl,
      directory: normalizeString(raw.directory),
      basicAuthUsername: normalizedUsername,
      basicAuthPassword: normalizedUsername ? normalizedPassword : '',
    };
  }

  function loadLegacyConfig() {
    for (const legacyKey of LEGACY_CONFIG_KEYS) {
      const legacyValue = gmGetValue(legacyKey, null);
      if (legacyValue && typeof legacyValue === 'object') {
        return legacyValue;
      }
    }

    const legacyBaseUrl = gmGetValue('opencodeBaseUrl', '');
    if (legacyBaseUrl && typeof legacyBaseUrl === 'string') {
      return {
        opencodeBaseUrl: legacyBaseUrl,
        directory: gmGetValue('opencodeDirectory', ''),
        basicAuthUsername: gmGetValue('opencodeBasicAuthUsername', ''),
        basicAuthPassword: gmGetValue('opencodeBasicAuthPassword', ''),
      };
    }

    return null;
  }

  function loadConfig() {
    const storedConfig = gmGetValue(STORAGE_KEY_CONFIG, null);
    if (storedConfig && typeof storedConfig === 'object') {
      return normalizeConfig(storedConfig, false);
    }

    const legacyConfig = loadLegacyConfig();
    if (legacyConfig) {
      const migrated = normalizeConfig(legacyConfig, false);
      gmSetValue(STORAGE_KEY_CONFIG, migrated);
      return migrated;
    }

    return {
      ...DEFAULT_CONFIG,
      opencodeBaseUrl: normalizeString(DEFAULT_CONFIG.opencodeBaseUrl) || detectDefaultBaseUrl(),
    };
  }

  function saveConfig(config) {
    const normalized = normalizeConfig(config, true);
    gmSetValue(STORAGE_KEY_CONFIG, normalized);
    state.config = normalized;
  }

  function requireConfiguredBaseUrl(config) {
    if (!config || typeof config !== 'object') {
      throw new ConfigError('Missing configuration. Use Settings to configure OpenCode endpoint.');
    }
    if (!normalizeString(config.opencodeBaseUrl)) {
      throw new ConfigError('OpenCode base URL is missing. Use Settings to configure endpoint.');
    }
    validateBaseUrl(config.opencodeBaseUrl);
  }

  function hasBasicAuthCredentials(config) {
    return Boolean(
      config &&
        normalizeString(config.basicAuthUsername) &&
        typeof config.basicAuthPassword === 'string' &&
        config.basicAuthPassword.length > 0,
    );
  }

  function parseResponseHeaders(rawHeaders) {
    const headerMap = {};
    if (!rawHeaders || typeof rawHeaders !== 'string') {
      return headerMap;
    }

    const lines = rawHeaders.split(/\r?\n/);
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator <= 0) {
        continue;
      }
      const headerName = line.slice(0, separator).trim().toLowerCase();
      const headerValue = line.slice(separator + 1).trim();
      if (headerName) {
        headerMap[headerName] = headerValue;
      }
    }
    return headerMap;
  }

  function encodeBasicAuth(username, password) {
    const encoded = window.btoa(unescape(encodeURIComponent(`${username}:${password}`)));
    return `Basic ${encoded}`;
  }

  function buildRequestUrl(baseUrl, path, query, directory) {
    const url = new URL(path, `${baseUrl.replace(/\/+$/, '')}/`);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }
    if (directory) {
      url.searchParams.set('directory', directory);
    }
    return url.toString();
  }

  function createRequestPayload(config, options, useBasicAuth) {
    const headers = {
      Accept: 'application/json',
      ...(options.headers || {}),
    };

    if (options.directory) {
      headers['x-opencode-directory'] = options.directory;
    }

    if (useBasicAuth) {
      headers.Authorization = encodeBasicAuth(
        normalizeString(config.basicAuthUsername),
        config.basicAuthPassword,
      );
    }

    let body = undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const requestUrl = buildRequestUrl(
      config.opencodeBaseUrl,
      options.path,
      options.query,
      options.directory,
    );

    return {
      method: options.method,
      url: requestUrl,
      headers,
      body,
    };
  }

  function gmRequest(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: payload.method,
        url: payload.url,
        headers: payload.headers,
        data: payload.body,
        timeout: REQUEST_TIMEOUT_MS,
        withCredentials: true,
        anonymous: false,
        responseType: 'text',
        onload: (response) => {
          resolve({
            status: response.status,
            text: typeof response.responseText === 'string' ? response.responseText : '',
            headers: parseResponseHeaders(response.responseHeaders || ''),
          });
        },
        ontimeout: () => {
          reject(new NetworkRequestError('Request timed out while contacting OpenCode.'));
        },
        onerror: () => {
          reject(new NetworkRequestError('Network/CORS failure while contacting OpenCode.'));
        },
      });
    });
  }

  async function fetchRequest(payload) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(payload.url, {
        method: payload.method,
        headers: payload.headers,
        body: payload.body,
        credentials: 'include',
        signal: controller.signal,
      });
      const text = await response.text();
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        status: response.status,
        text,
        headers,
      };
    } catch (_error) {
      throw new NetworkRequestError('Network/CORS failure while contacting OpenCode.');
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function rawRequest(payload) {
    const canUseGm = typeof GM_xmlhttpRequest === 'function';
    let sameOrigin = false;
    try {
      const requestOrigin = new URL(payload.url, window.location.href).origin;
      sameOrigin = requestOrigin === window.location.origin;
    } catch (_error) {
      sameOrigin = false;
    }

    // Prefer page-context fetch for same-origin requests so existing browser
    // session/auth state is reused. Fall back to GM request when needed.
    if (sameOrigin) {
      try {
        return await fetchRequest(payload);
      } catch (error) {
        if (!canUseGm) {
          throw error;
        }
        return gmRequest(payload);
      }
    }

    if (canUseGm) {
      return gmRequest(payload);
    }
    return fetchRequest(payload);
  }

  async function requestJson(config, options) {
    requireConfiguredBaseUrl(config);

    const tryRequest = async (useBasicAuth) => {
      const payload = createRequestPayload(config, options, useBasicAuth);
      return rawRequest(payload);
    };

    let response = await tryRequest(false);
    if (
      (response.status === 401 || response.status === 403) &&
      hasBasicAuthCredentials(config)
    ) {
      response = await tryRequest(true);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new HttpRequestError(
        response.status,
        `OpenCode request failed with HTTP ${response.status}.`,
      );
    }

    if (options.expectJson === false) {
      return {
        status: response.status,
        data: response.text,
      };
    }

    if (!response.text.trim()) {
      return {
        status: response.status,
        data: null,
      };
    }

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new ResponseShapeError('OpenCode returned HTML instead of JSON.');
    }

    try {
      return {
        status: response.status,
        data: JSON.parse(response.text),
      };
    } catch (_error) {
      throw new ResponseShapeError('OpenCode returned invalid JSON payload.');
    }
  }

  async function apiListSessions(config) {
    const response = await requestJson(config, {
      method: 'GET',
      path: '/session',
      query: {
        limit: DEFAULT_LIST_LIMIT,
      },
      directory: normalizeString(config.directory),
    });
    return response.data;
  }

  async function apiGetSession(config, sessionId, directory) {
    const response = await requestJson(config, {
      method: 'GET',
      path: `/session/${encodeURIComponent(sessionId)}`,
      directory: normalizeString(directory),
    });
    return response.data;
  }

  async function apiPatchSession(config, sessionId, title, directory) {
    const response = await requestJson(config, {
      method: 'PATCH',
      path: `/session/${encodeURIComponent(sessionId)}`,
      body: { title },
      directory: normalizeString(directory),
    });
    return response.data;
  }

  async function apiGetSessionMessages(config, sessionId, directory) {
    const response = await requestJson(config, {
      method: 'GET',
      path: `/session/${encodeURIComponent(sessionId)}/message`,
      directory: normalizeString(directory),
    });
    return response.data;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function asFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  function pickTimeValue(input, timeKey) {
    if (!isObject(input)) {
      return undefined;
    }
    const timeObject = isObject(input.time) ? input.time : null;
    const timeKeyAt = `${timeKey}At`;
    if (timeObject && timeKey in timeObject) {
      return asFiniteNumber(timeObject[timeKey]);
    }
    if (timeObject && timeKeyAt in timeObject) {
      return asFiniteNumber(timeObject[timeKeyAt]);
    }
    if (timeKey in input) {
      return asFiniteNumber(input[timeKey]);
    }
    return asFiniteNumber(input[timeKeyAt]);
  }

  function normalizeSessionRecord(record) {
    if (!isObject(record)) {
      return null;
    }

    const id = normalizeString(record.id);
    if (!id) {
      return null;
    }

    const recordTitle = normalizeString(record.title);
    const title = recordTitle || `Session ${id}`;

    const summary = isObject(record.summary)
      ? {
          additions: asFiniteNumber(record.summary.additions),
          deletions: asFiniteNumber(record.summary.deletions),
          files: asFiniteNumber(record.summary.files),
        }
      : undefined;

    return {
      id,
      title,
      updatedAt: pickTimeValue(record, 'updated'),
      archivedAt: pickTimeValue(record, 'archived'),
      directory: normalizeString(record.directory) || undefined,
      parentID: normalizeString(record.parentID) || undefined,
      summary,
      raw: record,
    };
  }

  function compareSessionFreshness(left, right) {
    const leftUpdated = typeof left.updatedAt === 'number' ? left.updatedAt : -Infinity;
    const rightUpdated = typeof right.updatedAt === 'number' ? right.updatedAt : -Infinity;
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }
    return left.id.localeCompare(right.id);
  }

  function isNewerSession(candidate, existing) {
    const candidateUpdated = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : -Infinity;
    const existingUpdated = typeof existing.updatedAt === 'number' ? existing.updatedAt : -Infinity;
    if (candidateUpdated !== existingUpdated) {
      return candidateUpdated > existingUpdated;
    }
    return candidate.title.length > existing.title.length;
  }

  function normalizeSessionList(payload) {
    if (!Array.isArray(payload)) {
      throw new ResponseShapeError('Expected OpenCode /session response to be a JSON array.');
    }

    const dedupedById = new Map();
    let malformedCount = 0;
    let duplicateCount = 0;

    for (const record of payload) {
      const normalized = normalizeSessionRecord(record);
      if (!normalized) {
        malformedCount += 1;
        continue;
      }

      const existing = dedupedById.get(normalized.id);
      if (!existing) {
        dedupedById.set(normalized.id, normalized);
        continue;
      }

      duplicateCount += 1;
      if (isNewerSession(normalized, existing)) {
        dedupedById.set(normalized.id, normalized);
      }
    }

    const items = Array.from(dedupedById.values()).sort(compareSessionFreshness);
    return {
      items,
      malformedCount,
      duplicateCount,
    };
  }

  function mapErrorForUi(error) {
    if (error instanceof ConfigError) {
      return {
        errorCode: 'unknown',
        message: error.message,
      };
    }
    if (error instanceof NetworkRequestError) {
      return {
        errorCode: 'source-network',
        message: 'Network/CORS failure while contacting OpenCode.',
      };
    }
    if (error instanceof ResponseShapeError) {
      return {
        errorCode: 'source-shape',
        message: 'OpenCode returned an unexpected response shape.',
      };
    }
    if (error instanceof HttpRequestError) {
      if (error.status === 401 || error.status === 403) {
        return {
          errorCode: 'source-auth',
          message:
            'Unauthorized by OpenCode (401/403). Re-authenticate or configure Basic Auth in Settings.',
        };
      }
      if (error.status === 404) {
        return {
          errorCode: 'unknown',
          message: 'Session not found (404).',
        };
      }
      if (error.status === 400) {
        return {
          errorCode: 'source-shape',
          message: 'OpenCode rejected the request (400).',
        };
      }
      return {
        errorCode: 'unknown',
        message: `OpenCode request failed with HTTP ${error.status}.`,
      };
    }
    return {
      errorCode: 'unknown',
      message: 'Unexpected error while processing session action.',
    };
  }

  function formatTimestamp(epochMs) {
    if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
      return '—';
    }
    return new Date(epochMs).toLocaleString();
  }

  function buildPipelineMessage() {
    const details = [];
    if (state.malformedCount > 0) {
      details.push(`Skipped malformed: ${state.malformedCount}`);
    }
    if (state.duplicateCount > 0) {
      details.push(`Deduped duplicates: ${state.duplicateCount}`);
    }
    return details.join(' • ');
  }

  function getVisibleSessions() {
    const search = state.searchTerm.trim().toLowerCase();
    return state.sessions.filter((session) => {
      if (!state.showArchived && typeof session.archivedAt === 'number') {
        return false;
      }

      if (!search) {
        return true;
      }

      return (
        session.title.toLowerCase().includes(search) || session.id.toLowerCase().includes(search)
      );
    });
  }

  function getBulkTargetSessions() {
    const byArchivedRule = (session) =>
      state.showArchived || typeof session.archivedAt !== 'number';
    if (state.bulkScope === 'all') {
      return state.sessions.filter(byArchivedRule);
    }
    return getVisibleSessions().filter(byArchivedRule);
  }

  function setRowStatus(sessionId, statusPatch) {
    const nextStatus = {
      state: 'idle',
      message: '',
      openUrl: '',
      ...statusPatch,
    };
    state.rowStatusById.set(sessionId, nextStatus);
  }

  function getRowStatus(sessionId) {
    return state.rowStatusById.get(sessionId) || {
      state: 'idle',
      message: '',
      openUrl: '',
    };
  }

  function resetRunState(total, mode) {
    state.runState = {
      inProgress: true,
      mode,
      processed: 0,
      total,
      revealed: 0,
      warning: 0,
      failed: 0,
    };
  }

  function finalizeRunState() {
    state.runState = {
      ...state.runState,
      inProgress: false,
      mode: null,
    };
  }

  function tallyRunResult(result) {
    state.runState.processed += 1;
    if (result.status === 'revealed') {
      state.runState.revealed += 1;
      return;
    }
    if (result.status === 'available-with-warning') {
      state.runState.warning += 1;
      return;
    }
    state.runState.failed += 1;
  }

  function encodeDirectorySegment(directory) {
    const value = normalizeString(directory);
    if (!value) {
      return '';
    }

    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return window
      .btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function resolveRuntimeSessionUrl(directory, sessionId) {
    const marker = '/session/';
    const pathname = window.location.pathname || '';
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }

    const originalPrefix = pathname.slice(0, markerIndex);
    const prefixSegments = originalPrefix.split('/').filter(Boolean);
    let prefix = originalPrefix;

    if (directory && prefixSegments.length === 1) {
      prefix = `/${encodeDirectorySegment(directory)}`;
    }

    return `${window.location.origin}${prefix}/session/${encodeURIComponent(sessionId)}`;
  }

  function resolveCanonicalSessionUrl(directory, sessionId) {
    const encodedDirectory = encodeDirectorySegment(directory);
    if (encodedDirectory) {
      return `${window.location.origin}/${encodedDirectory}/session/${encodeURIComponent(sessionId)}`;
    }
    return `${window.location.origin}/session/${encodeURIComponent(sessionId)}`;
  }

  function resolveSessionOpenUrl(directory, sessionId) {
    const runtimeUrl = resolveRuntimeSessionUrl(directory, sessionId);
    if (runtimeUrl) {
      return runtimeUrl;
    }
    return resolveCanonicalSessionUrl(directory, sessionId);
  }

  function pickSessionDirectory(normalizedSession, fetchedSession) {
    if (isObject(fetchedSession)) {
      const fetchedDirectory = normalizeString(fetchedSession.directory);
      if (fetchedDirectory) {
        return fetchedDirectory;
      }
    }

    if (normalizeString(normalizedSession.directory)) {
      return normalizedSession.directory;
    }
    return normalizeString(state.config.directory);
  }

  function pickSessionTitle(normalizedSession, fetchedSession) {
    if (isObject(fetchedSession)) {
      const fetchedTitle = normalizeString(fetchedSession.title);
      if (fetchedTitle) {
        return fetchedTitle;
      }
    }
    return normalizedSession.title || `Session ${normalizedSession.id}`;
  }

  async function revealSession(normalizedSession, options) {
    const prefetch = Boolean(options && options.prefetch);
    const initialDirectory = pickSessionDirectory(normalizedSession, null);

    try {
      const fetchedSession = await apiGetSession(
        state.config,
        normalizedSession.id,
        initialDirectory || normalizeString(state.config.directory),
      );
      const directory = pickSessionDirectory(normalizedSession, fetchedSession);
      if (!directory) {
        return {
          status: 'failed',
          sessionId: normalizedSession.id,
          message: 'Session directory is missing; unable to resolve open route.',
          uiSynced: false,
          errorCode: 'source-shape',
        };
      }

      const title = pickSessionTitle(normalizedSession, fetchedSession);

      let uiSynced = true;
      let syncWarning = null;
      try {
        await apiPatchSession(state.config, normalizedSession.id, title, directory);
      } catch (error) {
        uiSynced = false;
        syncWarning = error;
      }

      if (prefetch) {
        let prefetchWarningMessage = '';
        try {
          await apiGetSessionMessages(state.config, normalizedSession.id, directory);
        } catch (error) {
          const mappedPrefetchError = mapErrorForUi(error);
          prefetchWarningMessage = ` Transcript prefetch failed: ${mappedPrefetchError.message}`;
        }

        const openUrl = resolveSessionOpenUrl(directory, normalizedSession.id);
        if (uiSynced) {
          return {
            status: 'revealed',
            sessionId: normalizedSession.id,
            message: `Session revealed.${prefetchWarningMessage}`,
            uiSynced: true,
            openUrl,
          };
        }

        const syncMapped = mapErrorForUi(syncWarning);
        return {
          status: 'available-with-warning',
          sessionId: normalizedSession.id,
          message: `Session exists but visibility sync failed: ${syncMapped.message}${prefetchWarningMessage}`,
          uiSynced: false,
          warningCode: 'ui-sync-failed',
          openUrl,
        };
      }

      const openUrl = resolveSessionOpenUrl(directory, normalizedSession.id);
      if (uiSynced) {
        return {
          status: 'revealed',
          sessionId: normalizedSession.id,
          message: 'Session revealed.',
          uiSynced: true,
          openUrl,
        };
      }

      const syncMapped = mapErrorForUi(syncWarning);
      return {
        status: 'available-with-warning',
        sessionId: normalizedSession.id,
        message: `Session exists but visibility sync failed: ${syncMapped.message}`,
        uiSynced: false,
        warningCode: 'ui-sync-failed',
        openUrl,
      };
    } catch (error) {
      const mapped = mapErrorForUi(error);
      return {
        status: 'failed',
        sessionId: normalizedSession.id,
        message: mapped.message,
        uiSynced: false,
        errorCode: mapped.errorCode,
      };
    }
  }

  async function processSingleSession(normalizedSession, options) {
    setRowStatus(normalizedSession.id, {
      state: 'revealing',
      message: 'Revealing session...',
      openUrl: '',
    });
    render();

    const result = await revealSession(normalizedSession, options);

    if (result.status === 'revealed') {
      setRowStatus(normalizedSession.id, {
        state: 'revealed',
        message: result.message,
        openUrl: result.openUrl || '',
      });
    } else if (result.status === 'available-with-warning') {
      setRowStatus(normalizedSession.id, {
        state: 'warning',
        message: result.message,
        openUrl: result.openUrl || '',
      });
    } else {
      setRowStatus(normalizedSession.id, {
        state: 'failed',
        message: result.message,
        openUrl: result.openUrl || '',
      });
    }

    if (state.runState.inProgress) {
      tallyRunResult(result);
    }
    render();

    return result;
  }

  async function runSingleReveal(sessionId) {
    if (state.runState.inProgress || state.loadingSessions) {
      return;
    }

    const selected = state.sessions.find((session) => session.id === sessionId);
    if (!selected) {
      state.listMessage = 'Selected session is no longer present in current list.';
      state.listMessageKind = 'error';
      render();
      return;
    }

    resetRunState(1, 'single');
    render();
    const result = await processSingleSession(selected, { prefetch: true });
    finalizeRunState();
    render();

    if (
      (result.status === 'revealed' || result.status === 'available-with-warning') &&
      result.openUrl
    ) {
      window.location.assign(result.openUrl);
    }
  }

  async function runBulkReveal() {
    if (state.runState.inProgress || state.loadingSessions) {
      return;
    }

    const targets = getBulkTargetSessions();
    if (targets.length === 0) {
      state.listMessage = 'No sessions selected for Import All under current filters.';
      state.listMessageKind = 'info';
      render();
      return;
    }

    resetRunState(targets.length, 'bulk');
    render();

    for (const session of targets) {
      await processSingleSession(session, { prefetch: false });
    }

    finalizeRunState();
    state.listMessage = `Bulk reveal finished. Revealed: ${state.runState.revealed}, Warning: ${state.runState.warning}, Failed: ${state.runState.failed}.`;
    state.listMessageKind = 'info';
    render();
  }

  async function refreshSessions() {
    if (state.loadingSessions || state.runState.inProgress) {
      return;
    }

    state.loadingSessions = true;
    state.listMessage = 'Loading sessions...';
    state.listMessageKind = 'info';
    render();

    try {
      requireConfiguredBaseUrl(state.config);
      const payload = await apiListSessions(state.config);
      const normalized = normalizeSessionList(payload);
      state.sessions = normalized.items;
      state.malformedCount = normalized.malformedCount;
      state.duplicateCount = normalized.duplicateCount;
      state.lastRefreshAt = Date.now();
      state.listMessage = `Loaded ${normalized.items.length} session(s).`;
      state.listMessageKind = 'info';
    } catch (error) {
      const mapped = mapErrorForUi(error);
      state.sessions = [];
      state.malformedCount = 0;
      state.duplicateCount = 0;
      state.listMessage = mapped.message;
      state.listMessageKind = 'error';
    } finally {
      state.loadingSessions = false;
      render();
    }
  }

  function promptForConfig(currentConfig) {
    const baseInput = window.prompt(
      'OpenCode base URL (required):',
      currentConfig.opencodeBaseUrl || detectDefaultBaseUrl(),
    );
    if (baseInput === null) {
      return null;
    }
    const validatedBaseUrl = validateBaseUrl(baseInput);

    const directoryInput = window.prompt(
      'Directory scope (optional; leave blank for none):',
      currentConfig.directory || '',
    );
    if (directoryInput === null) {
      return null;
    }

    const usernameInput = window.prompt(
      'Basic auth username (optional):',
      currentConfig.basicAuthUsername || '',
    );
    if (usernameInput === null) {
      return null;
    }

    const passwordInput = window.prompt(
      'Basic auth password (optional). Leave blank to keep existing value, enter "-" to clear:',
      '',
    );
    if (passwordInput === null) {
      return null;
    }

    const normalizedUsername = normalizeString(usernameInput);
    let normalizedPassword = currentConfig.basicAuthPassword;
    if (!normalizedUsername) {
      normalizedPassword = '';
    } else if (passwordInput === '-') {
      normalizedPassword = '';
    } else if (passwordInput !== '') {
      normalizedPassword = passwordInput;
    }

    return normalizeConfig(
      {
        opencodeBaseUrl: validatedBaseUrl,
        directory: normalizeString(directoryInput),
        basicAuthUsername: normalizedUsername,
        basicAuthPassword: normalizedPassword,
      },
      true,
    );
  }

  async function configureEndpoint() {
    if (state.runState.inProgress) {
      return;
    }

    try {
      const nextConfig = promptForConfig(state.config);
      if (!nextConfig) {
        return;
      }

      saveConfig(nextConfig);
      state.listMessage = 'Configuration saved.';
      state.listMessageKind = 'info';
      render();
      if (state.overlayVisible) {
        await refreshSessions();
      }
    } catch (error) {
      const mapped = mapErrorForUi(error);
      state.listMessage = mapped.message;
      state.listMessageKind = 'error';
      render();
    }
  }

  function openOverlay() {
    state.overlayVisible = true;
    render();
    refreshSessions();
  }

  function closeOverlay() {
    state.overlayVisible = false;
    render();
  }

  function statusLabel(statusState) {
    if (statusState === 'revealing') {
      return 'revealing';
    }
    if (statusState === 'revealed') {
      return 'revealed';
    }
    if (statusState === 'warning') {
      return 'warning';
    }
    if (statusState === 'failed') {
      return 'failed';
    }
    return 'idle';
  }

  function registerMenuCommands() {
    gmRegisterMenuCommand('Open Session Reveal Overlay', openOverlay);
    gmRegisterMenuCommand('Configure OpenCode Endpoint', configureEndpoint);
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'ocsi-style';
    style.textContent = `
      #ocsi-root {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
      }
      #ocsi-root .ocsi-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
      }
      #ocsi-root .ocsi-panel {
        position: absolute;
        top: 6vh;
        left: 50%;
        transform: translateX(-50%);
        width: min(1100px, 94vw);
        max-height: 88vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        border-radius: 10px;
        background: #0f1219;
        color: #ecf0f9;
        border: 1px solid #26334f;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.42);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      }
      #ocsi-root .ocsi-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid #243352;
      }
      #ocsi-root .ocsi-header h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
      }
      #ocsi-root .ocsi-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        padding: 10px 16px;
        border-bottom: 1px solid #243352;
      }
      #ocsi-root .ocsi-controls button,
      #ocsi-root .ocsi-controls select,
      #ocsi-root .ocsi-controls input[type='text'],
      #ocsi-root .ocsi-header button {
        border-radius: 6px;
        border: 1px solid #385083;
        background: #17253f;
        color: #edf2fb;
        padding: 7px 10px;
        font-size: 12px;
      }
      #ocsi-root .ocsi-controls button:disabled,
      #ocsi-root .ocsi-header button:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }
      #ocsi-root .ocsi-controls label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
      }
      #ocsi-root .ocsi-status {
        padding: 8px 16px;
        border-bottom: 1px solid #243352;
        font-size: 12px;
        display: grid;
        row-gap: 4px;
      }
      #ocsi-root .ocsi-status-line[data-kind='error'] {
        color: #ff8d8d;
      }
      #ocsi-root .ocsi-status-line[data-kind='info'] {
        color: #a6b8de;
      }
      #ocsi-root .ocsi-table-wrap {
        overflow: auto;
        flex: 1;
      }
      #ocsi-root table {
        border-collapse: collapse;
        width: 100%;
        font-size: 12px;
      }
      #ocsi-root th,
      #ocsi-root td {
        border-bottom: 1px solid #1f2d4a;
        text-align: left;
        padding: 8px 10px;
        vertical-align: top;
      }
      #ocsi-root th {
        position: sticky;
        top: 0;
        background: #111a2f;
        z-index: 1;
      }
      #ocsi-root .ocsi-row-archived {
        opacity: 0.72;
      }
      #ocsi-root .ocsi-badge {
        display: inline-block;
        border-radius: 999px;
        padding: 3px 8px;
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.05em;
      }
      #ocsi-root .ocsi-badge-idle { background: #2c3f63; color: #cfe0ff; }
      #ocsi-root .ocsi-badge-revealing { background: #4b4a1a; color: #fffab7; }
      #ocsi-root .ocsi-badge-revealed { background: #214e2d; color: #bbffce; }
      #ocsi-root .ocsi-badge-warning { background: #5c3b0c; color: #ffe0aa; }
      #ocsi-root .ocsi-badge-failed { background: #5a2020; color: #ffc3c3; }
      #ocsi-root .ocsi-action-button {
        border-radius: 6px;
        border: 1px solid #4866a7;
        background: #1c2f53;
        color: #f0f5ff;
        padding: 6px 10px;
        font-size: 12px;
      }
      #ocsi-root .ocsi-open-link {
        margin-left: 8px;
        color: #8bc9ff;
      }
      #ocsi-root .ocsi-empty {
        color: #a7b5d4;
      }
      #ocsi-launcher {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483646;
        border-radius: 999px;
        border: 1px solid #2f4f82;
        background: #1f3460;
        color: #edf3ff;
        padding: 9px 14px;
        font-size: 12px;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      }
    `;
    document.head.appendChild(style);
  }

  function mountOverlay() {
    if (ui.mounted) {
      return;
    }

    const root = document.createElement('div');
    root.id = 'ocsi-root';
    root.innerHTML = `
      <div class="ocsi-backdrop" data-role="backdrop"></div>
      <section class="ocsi-panel" role="dialog" aria-modal="true" aria-labelledby="ocsi-title">
        <header class="ocsi-header">
          <h2 id="ocsi-title">OpenCode Session Reveal</h2>
          <button type="button" data-role="close">Close</button>
        </header>
        <div class="ocsi-controls">
          <button type="button" data-role="refresh">Refresh</button>
          <button type="button" data-role="import-all">Import All</button>
          <button type="button" data-role="settings">Settings</button>
          <label>
            Bulk scope
            <select data-role="bulk-scope">
              <option value="filtered">Filtered/Visible</option>
              <option value="all">All Loaded</option>
            </select>
          </label>
          <label>
            <input type="checkbox" data-role="show-archived" />
            Show archived
          </label>
          <input type="text" data-role="search" placeholder="Filter by title or id" />
        </div>
        <div class="ocsi-status">
          <div class="ocsi-status-line" data-role="notice" data-kind="info"></div>
          <div class="ocsi-status-line" data-role="pipeline" data-kind="info"></div>
          <div class="ocsi-status-line" data-role="progress" data-kind="info"></div>
          <div class="ocsi-status-line" data-role="summary" data-kind="info"></div>
          <div class="ocsi-status-line" data-role="count" data-kind="info"></div>
        </div>
        <div class="ocsi-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>ID</th>
                <th>Updated</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody data-role="rows"></tbody>
          </table>
        </div>
      </section>
    `;

    document.body.appendChild(root);

    ui.root = root;
    ui.refreshButton = root.querySelector('[data-role="refresh"]');
    ui.importAllButton = root.querySelector('[data-role="import-all"]');
    ui.settingsButton = root.querySelector('[data-role="settings"]');
    ui.closeButton = root.querySelector('[data-role="close"]');
    ui.bulkScopeSelect = root.querySelector('[data-role="bulk-scope"]');
    ui.showArchivedCheckbox = root.querySelector('[data-role="show-archived"]');
    ui.searchInput = root.querySelector('[data-role="search"]');
    ui.rowsBody = root.querySelector('[data-role="rows"]');
    ui.noticeLine = root.querySelector('[data-role="notice"]');
    ui.pipelineLine = root.querySelector('[data-role="pipeline"]');
    ui.progressLine = root.querySelector('[data-role="progress"]');
    ui.summaryLine = root.querySelector('[data-role="summary"]');
    ui.countLine = root.querySelector('[data-role="count"]');

    root.querySelector('[data-role="backdrop"]').addEventListener('click', closeOverlay);
    ui.closeButton.addEventListener('click', closeOverlay);

    ui.refreshButton.addEventListener('click', () => {
      refreshSessions();
    });
    ui.importAllButton.addEventListener('click', () => {
      runBulkReveal();
    });
    ui.settingsButton.addEventListener('click', () => {
      configureEndpoint();
    });
    ui.bulkScopeSelect.addEventListener('change', () => {
      state.bulkScope = ui.bulkScopeSelect.value === 'all' ? 'all' : 'filtered';
      render();
    });
    ui.showArchivedCheckbox.addEventListener('change', () => {
      state.showArchived = Boolean(ui.showArchivedCheckbox.checked);
      render();
    });
    ui.searchInput.addEventListener('input', () => {
      state.searchTerm = ui.searchInput.value;
      render();
    });
    ui.rowsBody.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        return;
      }
      const actionButton = target.closest('button[data-session-id]');
      if (!actionButton) {
        return;
      }
      const sessionId = actionButton.getAttribute('data-session-id');
      if (sessionId) {
        runSingleReveal(sessionId);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.overlayVisible) {
        closeOverlay();
      }
    });

    ui.mounted = true;
  }

  function mountLauncher() {
    const button = document.createElement('button');
    button.id = 'ocsi-launcher';
    button.type = 'button';
    button.textContent = 'Session Overlay';
    button.addEventListener('click', openOverlay);
    document.body.appendChild(button);
    ui.launcherButton = button;
  }

  function renderRow(session) {
    const rowStatus = getRowStatus(session.id);
    const row = document.createElement('tr');
    if (typeof session.archivedAt === 'number') {
      row.className = 'ocsi-row-archived';
    }

    const titleCell = document.createElement('td');
    titleCell.textContent =
      typeof session.archivedAt === 'number' ? `${session.title} (archived)` : session.title;

    const idCell = document.createElement('td');
    idCell.textContent = session.id;

    const updatedCell = document.createElement('td');
    updatedCell.textContent = formatTimestamp(session.updatedAt);

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    const label = statusLabel(rowStatus.state);
    badge.className = `ocsi-badge ocsi-badge-${label}`;
    badge.textContent = label;
    statusCell.appendChild(badge);
    if (rowStatus.message) {
      const messageLine = document.createElement('div');
      messageLine.textContent = rowStatus.message;
      statusCell.appendChild(messageLine);
    }

    const actionCell = document.createElement('td');
    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'ocsi-action-button';
    actionButton.setAttribute('data-session-id', session.id);
    actionButton.textContent = 'Import';
    actionButton.disabled = state.runState.inProgress || rowStatus.state === 'revealing';
    actionCell.appendChild(actionButton);

    if (rowStatus.openUrl) {
      const openLink = document.createElement('a');
      openLink.className = 'ocsi-open-link';
      openLink.href = rowStatus.openUrl;
      openLink.textContent = 'Open';
      openLink.target = '_self';
      actionCell.appendChild(openLink);
    }

    row.appendChild(titleCell);
    row.appendChild(idCell);
    row.appendChild(updatedCell);
    row.appendChild(statusCell);
    row.appendChild(actionCell);
    return row;
  }

  function renderRows() {
    ui.rowsBody.textContent = '';
    const visibleSessions = getVisibleSessions();

    if (state.loadingSessions) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'ocsi-empty';
      cell.textContent = 'Loading sessions...';
      row.appendChild(cell);
      ui.rowsBody.appendChild(row);
      return;
    }

    if (state.sessions.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'ocsi-empty';
      cell.textContent = 'No sessions loaded.';
      row.appendChild(cell);
      ui.rowsBody.appendChild(row);
      return;
    }

    if (visibleSessions.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'ocsi-empty';
      cell.textContent = 'No sessions match current filters.';
      row.appendChild(cell);
      ui.rowsBody.appendChild(row);
      return;
    }

    for (const session of visibleSessions) {
      ui.rowsBody.appendChild(renderRow(session));
    }
  }

  function renderStatus() {
    ui.noticeLine.setAttribute('data-kind', state.listMessageKind);
    ui.noticeLine.textContent = state.listMessage || '';

    const pipelineMessage = buildPipelineMessage();
    ui.pipelineLine.textContent = pipelineMessage || '';

    if (state.runState.total > 0) {
      ui.progressLine.textContent = `Progress: ${state.runState.processed} / ${state.runState.total}`;
      ui.summaryLine.textContent = `Revealed: ${state.runState.revealed} • Warning: ${state.runState.warning} • Failed: ${state.runState.failed}`;
    } else {
      ui.progressLine.textContent = '';
      ui.summaryLine.textContent = '';
    }

    const visibleCount = getVisibleSessions().length;
    const loadedCount = state.sessions.length;
    const refreshed = state.lastRefreshAt
      ? ` • Last refresh: ${new Date(state.lastRefreshAt).toLocaleTimeString()}`
      : '';
    ui.countLine.textContent = `Showing ${visibleCount} / ${loadedCount} loaded${refreshed}`;
  }

  function renderControls() {
    ui.root.style.display = state.overlayVisible ? 'block' : 'none';

    ui.searchInput.value = state.searchTerm;
    ui.bulkScopeSelect.value = state.bulkScope;
    ui.showArchivedCheckbox.checked = state.showArchived;

    const disableActions = state.runState.inProgress || state.loadingSessions;
    ui.refreshButton.disabled = disableActions;
    ui.settingsButton.disabled = state.runState.inProgress;
    ui.importAllButton.disabled = disableActions;

    ui.refreshButton.textContent = state.loadingSessions ? 'Refreshing...' : 'Refresh';
    ui.importAllButton.textContent = state.runState.inProgress ? 'Importing...' : 'Import All';
  }

  function render() {
    if (!ui.mounted) {
      return;
    }
    renderControls();
    renderStatus();
    renderRows();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
