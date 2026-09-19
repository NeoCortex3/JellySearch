/*
 * JellySearch - erweiterte Filter fuer Jellyfin (Filme & Serien).
 *
 * Wird vom JellySearch-Plugin in die jellyfin-web index.html injiziert.
 * Bietet:
 *   - einen zusaetzlichen Filter-Button neben den bestehenden Filtern
 *   - einen Jahres-Bereichsregler (Slider) statt einzelner Checkboxen
 *   - Tags als uebersichtliches Raster in mehreren Reihen
 *   - Tag-Ausschluss (drei Zustaende: aus / enthalten / ausgeschlossen)
 *
 * Die Jahres- und Include-Tag-Filter werden ueber die von jellyfin-web in
 * localStorage gespeicherten Library-View-Settings angewendet (useLocalStorage
 * synchronisiert via "local-storage"-Event, daher ohne Neuladen). Der
 * Tag-Ausschluss wird clientseitig umgesetzt, indem die /Items-Antworten
 * abgefangen und gefiltert werden.
 */
(function () {
    'use strict';

    var LOG = '[JellySearch]';
    function log() { try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) { /* noop */ } }
    function warn() { try { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) { /* noop */ } }

    // Routen, die unterstuetzt werden. Nur der jeweils erste Tab (Filme / Serien).
    var ROUTES = [
        { match: '/movies', viewType: 'movies', itemType: 'Movie', label: 'Filme' },
        { match: '/tv', viewType: 'series', itemType: 'Series', label: 'Serien' }
    ];

    var EXCLUDE_STORE_KEY = 'jellysearch-exclude-v1';

    var ICON_SVG =
        '<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeMedium jellysearch-icon" focusable="false" ' +
        'aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" ' +
        'd="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"></path></svg>';

    var _panel = null;
    var _panelState = null;
    var _button = null;
    var _currentContext = null;
    var _suppressStorageCleanup = false;

    // ------------------------------------------------------------------ utils

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // jellyfin-web uses a hash router, so both the route path and the query
    // parameters live inside window.location.hash (e.g. "#/movies?topParentId=...").
    function getHashLocation() {
        var hash = window.location.hash || '';
        if (hash.charAt(0) === '#') {
            hash = hash.slice(1);
        }
        var queryIndex = hash.indexOf('?');
        var path = queryIndex >= 0 ? hash.slice(0, queryIndex) : hash;
        var query = queryIndex >= 0 ? hash.slice(queryIndex + 1) : '';
        if (!path) {
            path = window.location.pathname;
            query = window.location.search.replace(/^\?/, '');
        }
        return { path: path, params: new URLSearchParams(query) };
    }

    function getContext() {
        var loc = getHashLocation();
        var path = loc.path.replace(/\/+$/, '');
        var route = null;
        for (var i = 0; i < ROUTES.length; i++) {
            if (path === ROUTES[i].match) {
                route = ROUTES[i];
                break;
            }
        }
        if (!route) {
            return null;
        }

        var tab = parseInt(loc.params.get('tab'), 10);
        if (!isNaN(tab) && tab !== 0) {
            return null;
        }

        var parentId = loc.params.get('topParentId') || loc.params.get('parentId');
        if (!parentId) {
            return null;
        }

        return {
            viewType: route.viewType,
            itemType: route.itemType,
            label: route.label,
            parentId: parentId,
            settingsKey: route.viewType + ' - ' + parentId
        };
    }

    function readJson(key) {
        try {
            var raw = window.localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function writeJson(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            warn('localStorage write failed', e);
            return false;
        }
    }

    function readSettings(ctx) {
        var settings = readJson(ctx.settingsKey);
        if (settings && typeof settings === 'object') {
            return settings;
        }
        return {
            ShowTitle: true,
            ShowYear: true,
            ViewMode: 'grid',
            ImageType: 'Primary',
            CardLayout: false,
            SortBy: ['SortName'],
            SortOrder: 'Ascending',
            StartIndex: 0
        };
    }

    function readExcludeStore() {
        var store = readJson(EXCLUDE_STORE_KEY);
        return (store && typeof store === 'object') ? store : {};
    }

    function getExcludeTags(parentId) {
        if (!parentId) {
            return [];
        }
        var store = readExcludeStore();
        var tags = store[parentId];
        return Array.isArray(tags) ? tags : [];
    }

    function setExcludeTags(parentId, tags) {
        var store = readExcludeStore();
        if (tags && tags.length) {
            store[parentId] = tags;
        } else {
            delete store[parentId];
        }
        writeJson(EXCLUDE_STORE_KEY, store);
    }

    // -------------------------------------------------------------- network

    function isItemsRequest(url) {
        try {
            var u = new URL(url, window.location.href);
            return /\/Items$/.test(u.pathname);
        } catch (e) {
            return false;
        }
    }

    function getQueryParam(url, name) {
        try {
            var u = new URL(url, window.location.href);
            return u.searchParams.get(name);
        } catch (e) {
            return null;
        }
    }

    function installNetworkHooks() {
        var proto = XMLHttpRequest.prototype;
        var origOpen = proto.open;
        var origText = Object.getOwnPropertyDescriptor(proto, 'responseText');
        var origResp = Object.getOwnPropertyDescriptor(proto, 'response');

        function rawText(xhr) {
            try { return origText && origText.get ? origText.get.call(xhr) : null; } catch (e) { return null; }
        }
        function rawResponse(xhr) {
            try { return origResp && origResp.get ? origResp.get.call(xhr) : null; } catch (e) { return null; }
        }

        function applyExclusion(data, excludes) {
            var lowered = excludes.map(function (t) { return String(t).toLowerCase(); });
            var before = data.Items.length;
            data.Items = data.Items.filter(function (item) {
                var tags = item && item.Tags;
                if (!tags || !tags.length) { return true; }
                for (var i = 0; i < tags.length; i++) {
                    if (lowered.indexOf(String(tags[i]).toLowerCase()) !== -1) {
                        return false;
                    }
                }
                return true;
            });
            var removed = before - data.Items.length;
            if (removed > 0 && typeof data.TotalRecordCount === 'number') {
                data.TotalRecordCount = Math.max(0, data.TotalRecordCount - removed);
            }
            return removed;
        }

        function buildFiltered(xhr) {
            if (!xhr.__jellysearchUrl || xhr.readyState !== 4) { return null; }
            if (!isItemsRequest(xhr.__jellysearchUrl)) { return null; }
            var parentId = getQueryParam(xhr.__jellysearchUrl, 'parentId');
            var excludes = getExcludeTags(parentId);
            if (!excludes.length) { return null; }

            var text = rawText(xhr);
            if (text != null) {
                var data;
                try { data = JSON.parse(text); } catch (e) { return null; }
                if (!data || !Array.isArray(data.Items)) { return null; }
                if (applyExclusion(data, excludes) === 0) { return null; }
                return { text: JSON.stringify(data) };
            }

            var obj = rawResponse(xhr);
            if (obj && typeof obj === 'object' && Array.isArray(obj.Items)) {
                var clone = Object.assign({}, obj);
                clone.Items = obj.Items.slice();
                if (applyExclusion(clone, excludes) === 0) { return null; }
                return { obj: clone };
            }
            return null;
        }

        proto.open = function (method, url) {
            var finalUrl = url;
            try {
                var candidate = (typeof url === 'string') ? url : String(url);
                if (isItemsRequest(candidate)) {
                    var parentId = getQueryParam(candidate, 'parentId');
                    if (getExcludeTags(parentId).length) {
                        candidate += (candidate.indexOf('?') === -1 ? '?' : '&') + 'fields=Tags';
                    }
                }
                finalUrl = candidate;
            } catch (e) { /* keep original */ }

            this.__jellysearchUrl = (typeof finalUrl === 'string') ? finalUrl : '';
            return origOpen.apply(this, [method, finalUrl].concat([].slice.call(arguments, 2)));
        };

        Object.defineProperty(proto, 'responseText', {
            configurable: true,
            get: function () {
                var filtered = buildFiltered(this);
                if (filtered && typeof filtered.text === 'string') { return filtered.text; }
                return rawText(this);
            }
        });

        Object.defineProperty(proto, 'response', {
            configurable: true,
            get: function () {
                var filtered = buildFiltered(this);
                if (filtered && filtered.obj) { return filtered.obj; }
                return rawResponse(this);
            }
        });
    }

    // -------------------------------------------------------------- api calls

    function apiClient() {
        return window.ApiClient || null;
    }

    function fetchJson(api, name, ctx) {
        return new Promise(function (resolve, reject) {
            try {
                var url = api.getUrl(name, {
                    userId: api.getCurrentUserId(),
                    parentId: ctx.parentId,
                    includeItemTypes: ctx.itemType
                });
                api.getJSON(url).then(resolve).catch(reject);
            } catch (e) {
                reject(e);
            }
        });
    }

    function fetchFilterOptions(ctx) {
        return new Promise(function (resolve) {
            var api = apiClient();
            if (!api || !api.getUrl || !api.getJSON) {
                resolve(null);
                return;
            }

            // "/Items/Filters" liefert Jahre und Tags; "/Items/Filters2" dient als Fallback.
            fetchJson(api, 'Items/Filters', ctx)
                .catch(function () { return fetchJson(api, 'Items/Filters2', ctx); })
                .then(function (data) {
                    if (!data) {
                        resolve(null);
                        return;
                    }
                    var years = [];
                    if (Array.isArray(data.Years)) {
                        years = data.Years.map(function (y) { return parseInt(y, 10); })
                            .filter(function (y) { return !isNaN(y); })
                            .sort(function (a, b) { return a - b; });
                    }
                    var tags = Array.isArray(data.Tags) ? data.Tags.slice() : [];
                    tags.sort(function (a, b) { return String(a).localeCompare(String(b)); });
                    resolve({ years: years, tags: tags });
                })
                .catch(function (err) {
                    warn('Filteroptionen konnten nicht geladen werden', err);
                    resolve(null);
                });
        });
    }

    // -------------------------------------------------------------- applying

    function applyFilters(ctx, yearMin, yearMax, allMin, allMax, includeTags, excludeTags) {
        var settings = readSettings(ctx);
        settings.Filters = settings.Filters || {};

        var isFullRange = (yearMin <= allMin && yearMax >= allMax);
        if (!isFullRange && allMin !== allMax) {
            var years = [];
            for (var y = yearMin; y <= yearMax; y++) { years.push(y); }
            settings.Filters.Years = years;
        } else {
            delete settings.Filters.Years;
        }

        if (includeTags && includeTags.length) {
            settings.Filters.Tags = includeTags.slice();
        } else {
            delete settings.Filters.Tags;
        }

        if (Object.keys(settings.Filters).length === 0) {
            delete settings.Filters;
        }

        settings.StartIndex = 0;
        settings.JellySearchNonce = Date.now();
        writeJson(ctx.settingsKey, settings);
        setExcludeTags(ctx.parentId, excludeTags || []);

        // useLocalStorage (usehooks-ts) lauscht auf dieses Event und aktualisiert den State.
        // Der Cleanup-Handler darf dabei unsere gerade gesetzten Ausschluesse nicht loeschen.
        _suppressStorageCleanup = true;
        try {
            window.dispatchEvent(new StorageEvent('local-storage', { key: ctx.settingsKey }));
        } catch (e) {
            window.dispatchEvent(new Event('storage'));
        }
        _suppressStorageCleanup = false;

        updateButtonState(ctx);
    }

    function resetFilters(ctx) {
        var settings = readSettings(ctx);
        if (settings.Filters) {
            delete settings.Filters.Years;
            delete settings.Filters.Tags;
            if (Object.keys(settings.Filters).length === 0) {
                delete settings.Filters;
            }
        }
        settings.StartIndex = 0;
        settings.JellySearchNonce = Date.now();
        writeJson(ctx.settingsKey, settings);
        setExcludeTags(ctx.parentId, []);
        try {
            window.dispatchEvent(new StorageEvent('local-storage', { key: ctx.settingsKey }));
        } catch (e) {
            window.dispatchEvent(new Event('storage'));
        }
        updateButtonState(ctx);
    }

    // ------------------------------------------------------------------- ui

    function findFilterButton() {
        var selectors = [
            'svg[data-testid="FilterAltIcon"]',
            'svg[data-testid*="FilterAlt"]',
            'svg[data-testid*="Filter"]'
        ];
        for (var i = 0; i < selectors.length; i++) {
            var icon = document.querySelector(selectors[i]);
            if (icon) {
                var button = icon.closest('button');
                if (button) { return button; }
            }
        }

        // Fallback: locate the button by its accessible title.
        var titled = document.querySelector('button[title="Filter"]')
            || document.querySelector('button[aria-label="Filter"]');
        return titled || null;
    }

    function ensureButton() {
        var ctx = getContext();
        _currentContext = ctx;

        if (!ctx) {
            if (_button && _button.parentNode) {
                _button.parentNode.removeChild(_button);
            }
            _button = null;
            return;
        }

        var filterBtn = findFilterButton();
        if (!filterBtn) {
            return;
        }

        if (_button && _button.isConnected) {
            updateButtonState(ctx);
            return;
        }

        _button = document.createElement('button');
        _button.id = 'jellysearch-button';
        _button.type = 'button';
        _button.className = 'MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium jellysearch-button';
        _button.title = 'Erweiterte Filter (JellySearch)';
        _button.setAttribute('aria-label', 'Erweiterte Filter');
        _button.innerHTML = '<span class="jellysearch-button-icon">' + ICON_SVG + '</span>' +
            '<span class="jellysearch-dot" aria-hidden="true"></span>';
        _button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            openPanel(ctx);
        });

        var group = filterBtn.closest('.MuiButtonGroup-root');
        if (group && group.parentNode) {
            group.parentNode.insertBefore(_button, group.nextSibling);
        } else {
            filterBtn.insertAdjacentElement('afterend', _button);
        }

        updateButtonState(ctx);
    }

    function updateButtonState(ctx) {
        if (!_button) { return; }
        var settings = readSettings(ctx);
        var hasTags = !!(settings.Filters && settings.Filters.Tags && settings.Filters.Tags.length);
        var hasYears = !!(settings.Filters && settings.Filters.Years && settings.Filters.Years.length);
        var hasExcludes = getExcludeTags(ctx.parentId).length > 0;
        _button.classList.toggle('jellysearch-active', hasTags || hasYears || hasExcludes);
    }

    function closePanel() {
        if (_panel && _panel.parentNode) {
            _panel.parentNode.removeChild(_panel);
        }
        _panel = null;
        _panelState = null;
        document.removeEventListener('mousedown', onDocumentMouseDown, true);
        document.removeEventListener('keydown', onDocumentKeyDown, true);
    }

    function onDocumentMouseDown(event) {
        if (_panel && !_panel.contains(event.target) && event.target !== _button) {
            closePanel();
        }
    }

    function onDocumentKeyDown(event) {
        if (event.key === 'Escape') {
            closePanel();
        }
    }

    function positionPanel(panel) {
        if (!_button) { return; }
        var rect = _button.getBoundingClientRect();
        var width = 380;
        var left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
        panel.style.position = 'fixed';
        panel.style.top = Math.min(rect.bottom + 8, window.innerHeight - 120) + 'px';
        panel.style.left = left + 'px';
        panel.style.width = width + 'px';
    }

    function openPanel(ctx) {
        closePanel();

        _panelState = {
            ctx: ctx,
            allMin: null,
            allMax: null,
            years: [],
            tags: [],
            include: new Set(),
            exclude: new Set(),
            tagFilter: '',
            loading: true
        };

        var settings = readSettings(ctx);
        var selectedYears = (settings.Filters && settings.Filters.Years) ? settings.Filters.Years.map(Number) : [];
        (settings.Filters && settings.Filters.Tags ? settings.Filters.Tags : []).forEach(function (t) {
            _panelState.include.add(t);
        });
        getExcludeTags(ctx.parentId).forEach(function (t) {
            _panelState.exclude.add(t);
        });

        _panel = document.createElement('div');
        _panel.className = 'jellysearch-panel';
        _panel.innerHTML = buildPanelHtml();
        document.body.appendChild(_panel);
        positionPanel(_panel);

        document.addEventListener('mousedown', onDocumentMouseDown, true);
        document.addEventListener('keydown', onDocumentKeyDown, true);

        _panel.querySelector('.jellysearch-close').addEventListener('click', closePanel);
        _panel.querySelector('.jellysearch-reset').addEventListener('click', function () {
            resetFilters(ctx);
            closePanel();
        });
        _panel.querySelector('.jellysearch-apply').addEventListener('click', function () {
            var st = _panelState;
            var include = Array.from(st.include);
            var exclude = Array.from(st.exclude);
            applyFilters(ctx, st.rangeMin, st.rangeMax, st.allMin, st.allMax, include, exclude);
            closePanel();
        });

        fetchFilterOptions(ctx).then(function (options) {
            if (!_panel || !_panelState) { return; }
            _panelState.loading = false;
            if (!options || (!options.years.length && !options.tags.length)) {
                _panelState.tags = [];
                _panelState.years = [];
                renderPanelBody();
                return;
            }
            _panelState.years = options.years;
            _panelState.tags = options.tags;
            _panelState.allMin = options.years.length ? options.years[0] : null;
            _panelState.allMax = options.years.length ? options.years[options.years.length - 1] : null;

            if (selectedYears.length) {
                _panelState.rangeMin = Math.max(_panelState.allMin, Math.min.apply(null, selectedYears));
                _panelState.rangeMax = Math.min(_panelState.allMax, Math.max.apply(null, selectedYears));
            } else {
                _panelState.rangeMin = _panelState.allMin;
                _panelState.rangeMax = _panelState.allMax;
            }
            renderPanelBody();
        });

        renderPanelBody();
    }

    function buildPanelHtml() {
        return '' +
            '<div class="jellysearch-header">' +
            '  <span class="jellysearch-title">Erweiterte Filter</span>' +
            '  <button type="button" class="jellysearch-close" aria-label="Schließen">&times;</button>' +
            '</div>' +
            '<div class="jellysearch-body"></div>' +
            '<div class="jellysearch-footer">' +
            '  <button type="button" class="jellysearch-btn jellysearch-reset">Zurücksetzen</button>' +
            '  <button type="button" class="jellysearch-btn jellysearch-btn-primary jellysearch-apply">Übernehmen</button>' +
            '</div>';
    }

    function renderPanelBody() {
        if (!_panel || !_panelState) { return; }
        var body = _panel.querySelector('.jellysearch-body');
        var st = _panelState;

        if (st.loading) {
            body.innerHTML = '<div class="jellysearch-loading">Filter werden geladen ...</div>';
            return;
        }

        if (!st.years.length && !st.tags.length) {
            body.innerHTML = '<div class="jellysearch-loading">Keine Filteroptionen gefunden.</div>';
            return;
        }

        var html = '';

        if (st.years.length > 1) {
            html += '' +
                '<div class="jellysearch-section">' +
                '  <div class="jellysearch-section-title">' +
                '    <span>Jahre</span>' +
                '    <span class="jellysearch-year-values">' +
                '      <span class="jellysearch-year-min">' + st.rangeMin + '</span>' +
                '      <span class="jellysearch-year-sep">&ndash;</span>' +
                '      <span class="jellysearch-year-max">' + st.rangeMax + '</span>' +
                '    </span>' +
                '  </div>' +
                '  <div class="jellysearch-slider">' +
                '    <div class="jellysearch-slider-track"><div class="jellysearch-slider-fill"></div></div>' +
                '    <input type="range" class="jellysearch-range jellysearch-range-min" min="' + st.allMin + '" max="' + st.allMax + '" step="1" value="' + st.rangeMin + '">' +
                '    <input type="range" class="jellysearch-range jellysearch-range-max" min="' + st.allMin + '" max="' + st.allMax + '" step="1" value="' + st.rangeMax + '">' +
                '  </div>' +
                '</div>';
        } else if (st.years.length === 1) {
            html += '<div class="jellysearch-section"><div class="jellysearch-section-title"><span>Jahr</span><span class="jellysearch-year-values">' + st.years[0] + '</span></div></div>';
        }

        if (st.tags.length) {
            html += '<div class="jellysearch-section">' +
                '  <div class="jellysearch-section-title"><span>Tags</span>' +
                '    <span class="jellysearch-hint">klicken: enthalten &rarr; ausschließen &rarr; aus</span>' +
                '  </div>' +
                '  <input type="text" class="jellysearch-tag-search" placeholder="Tags durchsuchen ..." value="' + escapeHtml(st.tagFilter || '') + '">' +
                '  <div class="jellysearch-tags"></div>' +
                '  <div class="jellysearch-tags-info"></div>' +
                '</div>';
        }

        body.innerHTML = html;

        if (st.years.length > 1) {
            var minInput = body.querySelector('.jellysearch-range-min');
            var maxInput = body.querySelector('.jellysearch-range-max');
            var fill = body.querySelector('.jellysearch-slider-fill');
            var minLabel = body.querySelector('.jellysearch-year-min');
            var maxLabel = body.querySelector('.jellysearch-year-max');

            var updateFill = function () {
                var lo = parseInt(minInput.value, 10);
                var hi = parseInt(maxInput.value, 10);
                var span = st.allMax - st.allMin || 1;
                var leftPct = ((lo - st.allMin) / span) * 100;
                var rightPct = ((hi - st.allMin) / span) * 100;
                fill.style.left = leftPct + '%';
                fill.style.width = Math.max(0, rightPct - leftPct) + '%';
                minLabel.textContent = lo;
                maxLabel.textContent = hi;
                st.rangeMin = lo;
                st.rangeMax = hi;
            };

            minInput.addEventListener('input', function () {
                if (parseInt(minInput.value, 10) > parseInt(maxInput.value, 10)) {
                    minInput.value = maxInput.value;
                }
                updateFill();
            });
            maxInput.addEventListener('input', function () {
                if (parseInt(maxInput.value, 10) < parseInt(minInput.value, 10)) {
                    maxInput.value = minInput.value;
                }
                updateFill();
            });
            updateFill();
        }

        var searchInput = body.querySelector('.jellysearch-tag-search');
        if (searchInput) {
            searchInput.addEventListener('input', function () {
                st.tagFilter = searchInput.value;
                renderTags();
            });
        }
        renderTags();
    }

    var TAG_RENDER_LIMIT = 300;

    function renderTags() {
        if (!_panel || !_panelState) { return; }
        var st = _panelState;
        var container = _panel.querySelector('.jellysearch-tags');
        var info = _panel.querySelector('.jellysearch-tags-info');
        if (!container) { return; }

        var query = (st.tagFilter || '').toLowerCase();
        var matches = query
            ? st.tags.filter(function (tag) { return String(tag).toLowerCase().indexOf(query) !== -1; })
            : st.tags;

        // Aktive Tags (enthalten/ausgeschlossen) immer ganz oben anzeigen - auch wenn
        // sie nicht zur aktuellen Suche passen, damit sie leicht aenderbar bleiben.
        var active = [];
        var inactive = [];
        matches.forEach(function (tag) {
            if (st.include.has(tag) || st.exclude.has(tag)) { active.push(tag); }
            else { inactive.push(tag); }
        });
        st.tags.forEach(function (tag) {
            if ((st.include.has(tag) || st.exclude.has(tag)) && active.indexOf(tag) === -1) {
                active.push(tag);
            }
        });

        var remaining = Math.max(0, TAG_RENDER_LIMIT - active.length);
        var shownInactive = inactive.slice(0, remaining);

        var chipHtml = function (tag) {
            var cls = 'jellysearch-tag';
            if (st.exclude.has(tag)) { cls += ' jellysearch-tag-exclude'; }
            else if (st.include.has(tag)) { cls += ' jellysearch-tag-include'; }
            return '<button type="button" class="' + cls + '" data-tag="' + escapeHtml(tag) + '">' +
                '<span class="jellysearch-tag-mark"></span>' + escapeHtml(tag) + '</button>';
        };

        var html = active.map(chipHtml).join('');
        if (active.length && shownInactive.length) {
            html += '<div class="jellysearch-tags-divider"></div>';
        }
        html += shownInactive.map(chipHtml).join('');
        container.innerHTML = html;

        if (info) {
            var shownCount = active.length + shownInactive.length;
            var total = active.length + inactive.length;
            info.textContent = total > TAG_RENDER_LIMIT
                ? (shownCount + ' von ' + total + ' Tags - Suche eingrenzen')
                : '';
        }

        container.querySelectorAll('.jellysearch-tag').forEach(function (chip) {
            chip.addEventListener('click', function () {
                var tag = chip.getAttribute('data-tag');
                if (st.exclude.has(tag)) {
                    st.exclude.delete(tag);
                } else if (st.include.has(tag)) {
                    st.include.delete(tag);
                    st.exclude.add(tag);
                } else {
                    st.include.add(tag);
                }
                chip.classList.remove('jellysearch-tag-include', 'jellysearch-tag-exclude');
                if (st.exclude.has(tag)) { chip.classList.add('jellysearch-tag-exclude'); }
                else if (st.include.has(tag)) { chip.classList.add('jellysearch-tag-include'); }
            });
        });
    }

    // ----------------------------------------------------------- lifecycle

    var _observer = null;

    function refresh() {
        ensureButton();
    }

    function scheduleRefresh() {
        if (refresh._scheduled) { return; }
        refresh._scheduled = true;
        window.setTimeout(function () {
            refresh._scheduled = false;
            refresh();
        }, 150);
    }

    function observeDom() {
        if (_observer) { return; }
        _observer = new MutationObserver(function () {
            scheduleRefresh();
        });
        _observer.observe(document.body, { childList: true, subtree: true });
    }

    function patchHistory() {
        ['pushState', 'replaceState'].forEach(function (name) {
            var orig = history[name];
            if (typeof orig !== 'function') { return; }
            history[name] = function () {
                var result = orig.apply(this, arguments);
                scheduleRefresh();
                return result;
            };
        });
        window.addEventListener('popstate', scheduleRefresh);
        window.addEventListener('hashchange', scheduleRefresh);
    }

    function watchStorage() {
        var handler = function (event) {
            if (!_currentContext) { return; }
            if (event.key && event.key !== _currentContext.settingsKey) { return; }
            var settings = readSettings(_currentContext);
            var hasOurFilters = !!(settings.Filters && ((settings.Filters.Tags && settings.Filters.Tags.length) || (settings.Filters.Years && settings.Filters.Years.length)));
            if (!hasOurFilters && !_suppressStorageCleanup && getExcludeTags(_currentContext.parentId).length) {
                setExcludeTags(_currentContext.parentId, []);
            }
            updateButtonState(_currentContext);
        };
        window.addEventListener('local-storage', handler);
        window.addEventListener('storage', handler);
    }

    function init() {
        log('initialisiert');
        installNetworkHooks();
        patchHistory();
        watchStorage();
        observeDom();
        scheduleRefresh();
        window.setInterval(scheduleRefresh, 2000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
