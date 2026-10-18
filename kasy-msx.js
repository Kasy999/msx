"use strict";
/**
 * Kasy TV for Media Station X (MSX).
 *
 * MSX only shows its own UI; external HTML pages run as invisible "interaction plugins" that answer MSX's requests
 * with menu/content JSON (https://msx.benzac.de/wiki/index.php?title=Interaction_Plugin). This plugin builds
 * Kasy TV's Live-TV (M3U + XMLTV) and Jellyfin library as MSX pages; videos are played by MSX's own player.
 *
 * Data IDs (request:interaction:{ID}@{plugin URL}):
 *   init                       main menu
 *   tv                         channel categories
 *   grp:{key}:{offset}         channels of a category (key URI-encoded)
 *   epg:{channelId}            programme panel of a channel
 *   jf                         Jellyfin start page
 *   jfresume                   continue watching
 *   jfl:{parentId}:{type}:{o}  library / folder
 *   jfs:{seriesId}             seasons of a series
 *   jfe:{seriesId}:{seasonId}  episodes of a season
 *   jfq:{term}                 search results
 *   settings, kb               settings page, on-screen keyboard
 */
(function () {
    var VERSION = '1.0.0';
    var SELF = location.href.split('#')[0].split('?')[0];
    var BASE = SELF.substring(0, SELF.lastIndexOf('/') + 1);
    var PREFIX = 'kasy_msx_';
    var CH_PAGE = 240;
    var JF_PAGE = 120;
    var ALL = '__all';
    var FAV = '__fav';

    // ---------------- Settings ----------------

    function load(key, def) {
        try {
            var v = localStorage.getItem(PREFIX + key);
            return v === null ? def : JSON.parse(v);
        } catch (e) {
            return def;
        }
    }

    function store(key, value) {
        try {
            if (value === null) localStorage.removeItem(PREFIX + key);
            else localStorage.setItem(PREFIX + key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    var DEFAULTS = {
        lang: 'de', m3uUrl: '', epgUrl: '', epgShift: 0,
        jfUrl: '', jfUser: '', jfPass: '', jfToken: '', jfUserId: '',
        favorites: [], deviceId: '',
    };
    var cfg = (function () {
        var c = load('cfg', {}) || {};
        for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && c[k] === undefined) c[k] = DEFAULTS[k];
        if (!c.deviceId) c.deviceId = 'kasy-msx-' + Math.random().toString(36).substring(2, 12);
        return c;
    })();

    function saveCfg() {
        store('cfg', cfg);
    }

    function T(de, en) {
        return cfg.lang === 'en' ? en : de;
    }

    // ---------------- Helpers ----------------

    function req(id) {
        return 'request:interaction:' + id + '@' + SELF;
    }

    function enc(s) {
        return encodeURIComponent(String(s));
    }

    /** MSX interprets {…} as inline expressions – strip braces from foreign texts. */
    function clean(s) {
        return String(s === undefined || s === null ? '' : s).replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function hhmm(ms) {
        var d = new Date(ms);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function dayTime(ms) {
        var d = new Date(ms);
        var today = new Date();
        if (d.toDateString() === today.toDateString()) return hhmm(ms);
        var days = cfg.lang === 'en' ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] : ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
        return days[d.getDay()] + ' ' + hhmm(ms);
    }

    /** Shortened URL for display (no credentials / tokens in the query). */
    function shortUrl(url) {
        if (!url) return '';
        var s = String(url).replace(/^https?:\/\//i, '').split('?')[0];
        return s.length > 42 ? s.substring(0, 20) + '…' + s.substring(s.length - 20) : s;
    }

    function query(params) {
        var out = [];
        for (var k in params) {
            if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
            var v = params[k];
            if (v === undefined || v === null || v === '') continue;
            out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        }
        return out.join('&');
    }

    function errorText(e) {
        if (e && e.network) {
            return T('Nicht erreichbar. Mögliche Ursachen: falsche Adresse, Server offline, der Server erlaubt keinen Zugriff von Web-Apps (CORS) oder eine http://-Adresse, während das Plugin über https:// geladen wird.',
                'Not reachable. Possible causes: wrong address, server offline, the server does not allow web apps (CORS) or an http:// address while the plugin is loaded via https://.');
        }
        return (e && e.message) || String(e);
    }

    function exec(action, data) {
        TVXInteractionPlugin.executeAction(action, data);
    }

    // ---------------- HTTP (with optional proxy of the local Kasy server) ----------------

    var proxyBase = null;

    function http(method, url, headers, body, timeout) {
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest();
            x.open(method, url, true);
            x.timeout = timeout || 30000;
            if (headers) for (var h in headers) if (Object.prototype.hasOwnProperty.call(headers, h)) x.setRequestHeader(h, headers[h]);
            x.onload = function () {
                resolve({ status: x.status, text: x.responseText });
            };
            x.onerror = x.ontimeout = function () {
                var e = new Error('network');
                e.network = true;
                reject(e);
            };
            x.send(body === undefined ? null : body);
        });
    }

    /** Direct request first; if the browser blocks it (CORS / mixed content) the proxy of kasy-server.ps1 is used. */
    function request(method, url, headers, body) {
        return http(method, url, headers, body).catch(function (e) {
            if (!proxyBase || !e.network) throw e;
            return http(method, proxyBase + enc(url), headers, body);
        });
    }

    function getText(url) {
        return request('GET', url).then(function (r) {
            if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
            if (!r.text) throw new Error(T('Leere Antwort vom Server.', 'Empty response from the server.'));
            return r.text;
        });
    }

    function detectProxy() {
        if (location.protocol !== 'http:') return Promise.resolve();
        return http('GET', BASE + 'proxy?ping=1', null, undefined, 4000).then(function (r) {
            if (r.status === 200 && r.text === 'kasy-proxy') proxyBase = BASE + 'proxy?url=';
        }).catch(function () {});
    }

    /** Optional config.json next to the plugin: fills settings that are still empty (handy when typing URLs on the TV). */
    function loadConfigFile() {
        return http('GET', BASE + 'config.json', null, undefined, 5000).then(function (r) {
            if (r.status !== 200 || !r.text) return;
            var c;
            try {
                c = JSON.parse(r.text);
            } catch (e) {
                return;
            }
            var changed = false;
            ['lang', 'm3uUrl', 'epgUrl', 'jfUrl', 'jfUser', 'jfPass'].forEach(function (k) {
                if (typeof c[k] === 'string' && c[k] && (c.override === true || !cfg[k])) {
                    if (cfg[k] !== c[k]) changed = true;
                    cfg[k] = c[k];
                }
            });
            if (typeof c.epgShift === 'number' && (c.override === true || !cfg.epgShift)) cfg.epgShift = c.epgShift;
            if (changed) {
                cfg.jfToken = c.override === true ? '' : cfg.jfToken;
                saveCfg();
            }
        }).catch(function () {});
    }

    // ---------------- Live TV (M3U + XMLTV) ----------------

    var tv = {
        channels: [], byId: {}, groups: [], epgHints: [],
        loaded: false, loading: null, error: null, updatedAt: 0,
        epg: {}, epgLoading: false, epgError: null, epgMapped: 0,
    };
    var rawEpg = null;

    function setChannels(channels, epgUrls) {
        var byId = {};
        var groups = [];
        var seen = {};
        channels.forEach(function (ch) {
            byId[ch.id] = ch;
            if (!seen['$' + ch.group]) {
                seen['$' + ch.group] = true;
                groups.push(ch.group);
            }
        });
        tv.channels = channels;
        tv.byId = byId;
        tv.groups = groups;
        tv.epgHints = epgUrls || [];
        tv.loaded = true;
    }

    function restoreChannels() {
        var cached = load('channels', null);
        if (cached && cached.url === cfg.m3uUrl && cached.channels && cached.channels.length) {
            setChannels(cached.channels, cached.epgUrls);
            tv.updatedAt = cached.at || 0;
        }
    }

    function loadPlaylist() {
        if (tv.loading) return tv.loading;
        if (!cfg.m3uUrl) {
            setChannels([], []);
            tv.error = null;
            return Promise.resolve();
        }
        var url = cfg.m3uUrl;
        tv.loading = getText(url).then(function (text) {
            var parsed = M3uParser.parse(text);
            if (!parsed.channels.length) throw new Error(T('Die Datei enthält keine Sender.', 'The file contains no channels.'));
            setChannels(parsed.channels, parsed.epgUrls);
            tv.error = null;
            tv.updatedAt = Date.now();
            // Large playlists may not fit into the storage – then they are simply loaded again next time.
            if (!store('channels', { url: url, at: tv.updatedAt, channels: parsed.channels, epgUrls: parsed.epgUrls })) store('channels', null);
            if (rawEpg) mapEpg();
            loadEpg();
        }).catch(function (e) {
            tv.error = errorText(e);
            tv.loaded = true;
        }).then(function () {
            tv.loading = null;
        });
        return tv.loading;
    }

    function whenTvReady() {
        if (tv.loading) return tv.loading;
        if (!tv.loaded && cfg.m3uUrl) return loadPlaylist();
        return Promise.resolve();
    }

    /** Channel pages wait a moment for a guide that is still loading, so "now playing" is there on the first visit. */
    function whenEpgReady(maxMs) {
        if (!tv.epgLoading || !tv.epgPromise) return Promise.resolve();
        return Promise.race([tv.epgPromise, new Promise(function (r) { setTimeout(r, maxMs); })]);
    }

    function epgUrl() {
        return cfg.epgUrl || tv.epgHints[0] || '';
    }

    function loadEpg() {
        var url = epgUrl();
        if (!url || !tv.channels.length || tv.epgLoading) return;
        var wantedIds = {};
        var wantedNames = {};
        tv.channels.forEach(function (ch) {
            if (ch.tvgId) wantedIds[ch.tvgId.toLowerCase()] = true;
            if (ch.tvgName) wantedNames[Xmltv.normalizeName(ch.tvgName)] = true;
            wantedNames[Xmltv.normalizeName(ch.name)] = true;
        });
        var now = Date.now();
        // Only what the pages show (now playing, next hours) – keeps the memory of the TV low.
        var filter = {
            fromMs: now - 4 * 3600000,
            toMs: now + 2 * 86400000,
            acceptChannel: function (id, names) {
                if (wantedIds[id.toLowerCase()]) return true;
                for (var i = 0; i < names.length; i++) if (wantedNames[Xmltv.normalizeName(names[i])]) return true;
                return !!wantedNames[Xmltv.normalizeName(id)];
            },
        };
        tv.epgLoading = true;
        tv.epgError = null;
        tv.epgPromise = Xmltv.load(url, filter).catch(function (e) {
            if (!proxyBase) throw e;
            return Xmltv.load(proxyBase + enc(url), filter);
        }).then(function (parsed) {
            var programs = {};
            for (var k in parsed.programs) {
                if (Object.prototype.hasOwnProperty.call(parsed.programs, k)) programs[k.toLowerCase()] = parsed.programs[k];
            }
            rawEpg = { programs: programs, displayNames: parsed.displayNames };
            mapEpg();
        }).catch(function (e) {
            tv.epgError = e && e.message === 'Failed to fetch' ? errorText({ network: true }) : errorText(e);
        }).then(function () {
            tv.epgLoading = false;
        });
    }

    function mapEpg() {
        if (!rawEpg) return;
        var programs = rawEpg.programs;
        var names = rawEpg.displayNames || {};
        var epg = {};
        var mapped = 0;
        tv.channels.forEach(function (ch) {
            var id = null;
            if (ch.tvgId && programs[ch.tvgId.toLowerCase()]) id = ch.tvgId.toLowerCase();
            if (!id && ch.tvgName && names[Xmltv.normalizeName(ch.tvgName)]) id = names[Xmltv.normalizeName(ch.tvgName)].toLowerCase();
            if (!id && names[Xmltv.normalizeName(ch.name)]) id = names[Xmltv.normalizeName(ch.name)].toLowerCase();
            if (!id && programs[Xmltv.normalizeName(ch.name)]) id = Xmltv.normalizeName(ch.name);
            var list = id ? programs[id] : null;
            if (!list) return;
            var shift = Math.round(((cfg.epgShift || 0) + (ch.tvgShiftHours || 0)) * 3600000);
            epg[ch.id] = list.map(function (p) {
                return { start: p[0] + shift, stop: p[1] + shift, title: p[2], desc: p[3] };
            });
            mapped++;
        });
        tv.epg = epg;
        tv.epgMapped = mapped;
    }

    function programmes(ch) {
        return (ch && tv.epg[ch.id]) || [];
    }

    function firstEndingAfter(list, t) {
        var lo = 0;
        var hi = list.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (list[mid].stop <= t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function currentProgramme(ch, now) {
        var list = programmes(ch);
        var p = list[firstEndingAfter(list, now)];
        return p && p.start <= now && now < p.stop ? p : null;
    }

    function isFav(id) {
        return cfg.favorites.indexOf(id) >= 0;
    }

    function categories() {
        var count = {};
        tv.channels.forEach(function (ch) { count['$' + ch.group] = (count['$' + ch.group] || 0) + 1; });
        var favCount = cfg.favorites.filter(function (id) { return !!tv.byId[id]; }).length;
        var out = [
            { key: ALL, title: T('Alle Sender', 'All channels'), count: tv.channels.length, icon: 'live-tv' },
            { key: FAV, title: T('Favoriten', 'Favorites'), count: favCount, icon: 'star' },
        ];
        tv.groups.forEach(function (g) { out.push({ key: g, title: g, count: count['$' + g] || 0, icon: 'folder' }); });
        return out;
    }

    function channelsIn(key) {
        if (key === ALL) return tv.channels;
        if (key === FAV) {
            return cfg.favorites.map(function (id) { return tv.byId[id]; }).filter(Boolean);
        }
        return tv.channels.filter(function (ch) { return ch.group === key; });
    }

    function categoryTitle(key) {
        if (key === ALL) return T('Alle Sender', 'All channels');
        if (key === FAV) return T('Favoriten', 'Favorites');
        return key;
    }

    // ---------------- Jellyfin ----------------

    var JF_FIELDS = 'Overview,PrimaryImageAspectRatio,ChildCount,MediaSources';
    var DIRECT_CONTAINERS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'ts', 'mpegts', 'm2ts'];

    function jfBase() {
        var url = String(cfg.jfUrl || '').trim().replace(/\/+$/, '');
        if (url && !/^https?:\/\//i.test(url)) url = 'http://' + url;
        return url;
    }

    function jfLoggedIn() {
        return !!(jfBase() && cfg.jfToken && cfg.jfUserId);
    }

    function jfAuth() {
        var s = 'MediaBrowser Client="Kasy TV", Device="Media Station X", DeviceId="' + cfg.deviceId + '", Version="' + VERSION + '"';
        if (cfg.jfToken) s += ', Token="' + cfg.jfToken + '"';
        return s;
    }

    function jfRequest(method, path, params, body) {
        var q = params ? query(params) : '';
        var url = jfBase() + '/' + path + (q ? '?' + q : '');
        var headers = { 'X-Emby-Authorization': jfAuth(), 'Accept': 'application/json' };
        if (body) headers['Content-Type'] = 'application/json';
        return request(method, url, headers, body ? JSON.stringify(body) : undefined).then(function (r) {
            if (r.status === 401) {
                var e = new Error(T('Anmeldung abgelaufen oder falsch (401).', 'Login expired or wrong (401).'));
                e.code = 401;
                throw e;
            }
            if (r.status < 200 || r.status >= 300) {
                var err = new Error('Jellyfin: HTTP ' + r.status);
                err.code = r.status;
                throw err;
            }
            if (!r.text) return null;
            try {
                return JSON.parse(r.text);
            } catch (e) {
                return null;
            }
        });
    }

    /** New endpoint first (10.9+), legacy /Users/{id}/… route as fallback (10.8). */
    function jfGet(primary, params, legacy, legacyParams) {
        return jfRequest('GET', primary, params).catch(function (e) {
            if (legacy && (e.code === 400 || e.code === 404 || e.code === 405)) return jfRequest('GET', legacy, legacyParams);
            throw e;
        });
    }

    /** With an expired token the stored password is used once to log in again. */
    function jfCall(fn) {
        return fn().catch(function (e) {
            if (e.code !== 401 || !cfg.jfUser) throw e;
            return jfLogin().then(fn);
        });
    }

    function jfLogin() {
        if (!jfBase() || !cfg.jfUser) return Promise.reject(new Error(T('Bitte Server und Benutzer eintragen.', 'Please enter server and user.')));
        cfg.jfToken = '';
        return jfRequest('POST', 'Users/AuthenticateByName', null, { Username: cfg.jfUser, Pw: cfg.jfPass || '' }).then(function (auth) {
            if (!auth || !auth.AccessToken || !auth.User) throw new Error(T('Anmeldung fehlgeschlagen.', 'Login failed.'));
            cfg.jfToken = auth.AccessToken;
            cfg.jfUserId = auth.User.Id;
            saveCfg();
        });
    }

    function jfItems(r) {
        return (r && r.Items) || (Array.isArray(r) ? r : []);
    }

    function jfImage(id, type, tag, maxHeight) {
        return jfBase() + '/Items/' + id + '/Images/' + type + '?' + query({ maxHeight: maxHeight || 480, quality: 90, tag: tag });
    }

    function jfPoster(it) {
        var tags = it.ImageTags || {};
        if (tags.Primary) return jfImage(it.Id, 'Primary', tags.Primary);
        if (it.SeriesId && it.SeriesPrimaryImageTag) return jfImage(it.SeriesId, 'Primary', it.SeriesPrimaryImageTag);
        return null;
    }

    function jfThumb(it) {
        var tags = it.ImageTags || {};
        if (tags.Primary) return jfImage(it.Id, 'Primary', tags.Primary, 360);
        if (tags.Thumb) return jfImage(it.Id, 'Thumb', tags.Thumb, 360);
        if (it.ParentBackdropItemId && it.ParentBackdropImageTags && it.ParentBackdropImageTags.length) {
            return jfImage(it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags[0], 360);
        }
        return jfPoster(it);
    }

    function jfSource(it) {
        return (it.MediaSources && it.MediaSources[0]) || null;
    }

    function jfStreamUrl(it) {
        var source = jfSource(it);
        var container = source && source.Container ? source.Container.split(',')[0].trim().toLowerCase() : '';
        if (container && DIRECT_CONTAINERS.indexOf(container) >= 0) {
            return jfBase() + '/Videos/' + it.Id + '/stream.' + container + '?' +
                query({ static: 'true', MediaSourceId: source.Id, DeviceId: cfg.deviceId, api_key: cfg.jfToken });
        }
        return jfTranscodeUrl(it, 0);
    }

    /** HLS transcoded by the server (formats the TV cannot play, or resuming at a position). */
    function jfTranscodeUrl(it, startTicks) {
        var source = jfSource(it);
        return jfBase() + '/Videos/' + it.Id + '/master.m3u8?' + query({
            MediaSourceId: source ? source.Id : it.Id,
            DeviceId: cfg.deviceId,
            PlaySessionId: Math.random().toString(36).substring(2, 12),
            api_key: cfg.jfToken,
            VideoCodec: 'h264,hevc',
            AudioCodec: 'aac,ac3,eac3,mp3',
            VideoBitrate: '19808000',
            AudioBitrate: '192000',
            MaxStreamingBitrate: '20000000',
            MaxHeight: '1080',
            TranscodingMaxAudioChannels: '6',
            SegmentContainer: 'ts',
            MinSegments: '1',
            BreakOnNonKeyFrames: 'true',
            StartTimeTicks: startTicks > 0 ? String(startTicks) : null,
        });
    }

    function jfPlayable(it) {
        return ['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer'].indexOf(it.Type) >= 0;
    }

    function jfEpisodeLabel(it) {
        var s = '';
        if (it.ParentIndexNumber !== undefined && it.ParentIndexNumber !== null) s += 'S' + it.ParentIndexNumber;
        if (it.IndexNumber !== undefined && it.IndexNumber !== null) s += 'E' + it.IndexNumber;
        return s;
    }

    function jfDuration(ticks) {
        var min = Math.floor(ticks / 600000000);
        return min >= 60 ? Math.floor(min / 60) + ' h ' + pad2(min % 60) + ' min' : min + ' min';
    }

    // ---------------- MSX page builders ----------------

    function control(layout, icon, label, extension, data) {
        return { type: 'control', layout: layout, icon: icon, label: label, extensionLabel: extension, action: 'interaction:commit', data: data };
    }

    /** A page with a text and buttons (empty states, errors). */
    function notice(title, text, buttons) {
        var items = [{ type: 'space', layout: '0,0,12,3', color: 'msx-glass', headline: title, text: clean(text) }];
        (buttons || []).forEach(function (b, i) {
            items.push({ type: 'control', layout: (i * 4) + ',4,4,1', icon: b.icon, label: b.label, action: b.action, data: b.data });
        });
        if (!buttons || !buttons.length) items.push({ type: 'control', layout: '0,4,4,1', icon: 'arrow-back', label: T('Zurück', 'Back'), action: 'back' });
        return { type: 'pages', cache: false, headline: title, pages: [{ items: items }] };
    }

    var settingsButton = function () {
        return { icon: 'settings', label: T('Einstellungen', 'Settings'), action: 'content:' + req('settings') };
    };

    function menuRoot() {
        return {
            name: 'Kasy TV',
            version: VERSION,
            headline: 'Kasy TV',
            menu: [
                { icon: 'live-tv', label: T('Live-TV', 'Live TV'), data: req('tv') },
                { icon: 'star', label: T('Favoriten', 'Favorites'), data: req('grp:' + enc(FAV) + ':0') },
                { type: 'separator' },
                { icon: 'video-library', label: T('Videothek', 'Library'), data: req('jf') },
                { type: 'separator' },
                { icon: 'settings', label: T('Einstellungen', 'Settings'), data: req('settings') },
            ],
        };
    }

    function tvStatus() {
        if (tv.loading) return T('Lädt …', 'Loading …');
        var s = tv.channels.length + ' ' + T('Sender', 'channels');
        if (tv.epgLoading) s += ' · EPG ' + T('lädt …', 'loading …');
        else if (tv.epgMapped) s += ' · EPG ' + tv.epgMapped;
        else if (tv.epgError) s += ' · EPG ' + T('Fehler', 'error');
        return s;
    }

    function tvRoot() {
        if (!cfg.m3uUrl) {
            return notice(T('Keine Playlist eingerichtet', 'No playlist set up'),
                T('Trage in den Einstellungen die Adresse deiner M3U-Playlist ein (optional auch die EPG-Adresse).',
                    'Enter the address of your M3U playlist in the settings (optionally also the EPG address).'),
                [settingsButton()]);
        }
        if (tv.error && !tv.channels.length) {
            return notice(T('Playlist konnte nicht geladen werden', 'The playlist could not be loaded'), tv.error, [
                { icon: 'refresh', label: T('Erneut versuchen', 'Try again'), action: 'interaction:commit', data: { a: 'reloadTv' } },
                settingsButton(),
            ]);
        }
        var items = categories().map(function (c) {
            return {
                icon: c.icon,
                label: clean(c.title),
                extensionLabel: String(c.count),
                action: 'content:' + req('grp:' + enc(c.key) + ':0'),
            };
        });
        return {
            type: 'list',
            cache: false,
            headline: T('Live-TV', 'Live TV'),
            extension: tvStatus(),
            template: { type: 'control', layout: '0,0,6,1', enumerate: false },
            items: items,
        };
    }

    function channelOptions(ch) {
        var fav = isFav(ch.id);
        return {
            headline: clean(ch.name),
            template: { type: 'control', layout: '0,0,8,1', enumerate: false },
            items: [
                { icon: 'play-arrow', label: T('Abspielen', 'Play'), action: 'video:' + ch.url, playerLabel: clean(ch.name) },
                { icon: fav ? 'star' : 'star-border', label: fav ? T('Aus Favoriten entfernen', 'Remove from favorites') : T('Zu Favoriten hinzufügen', 'Add to favorites'), action: '[back|interaction:commit]', data: { a: 'fav', id: ch.id } },
                { icon: 'list', label: T('Programm anzeigen', 'Show guide'), action: 'panel:' + req('epg:' + enc(ch.id)) },
            ],
        };
    }

    function channelItem(ch, now) {
        var p = currentProgramme(ch, now);
        var item = {
            title: clean(ch.name),
            titleFooter: p ? hhmm(p.start) + ' ' + clean(p.title) : '',
            playerLabel: clean(ch.name) + (p ? ' – ' + clean(p.title) : ''),
            action: 'video:' + ch.url,
            options: channelOptions(ch),
        };
        if (ch.logo) item.image = ch.logo;
        else item.icon = 'msx-white-soft:live-tv';
        if (p) item.progress = (now - p.start) / (p.stop - p.start);
        if (isFav(ch.id)) item.tag = '{ico:msx-yellow:star}';
        return item;
    }

    function groupPage(key, offset) {
        var list = channelsIn(key);
        var title = categoryTitle(key);
        if (!list.length) {
            if (key === FAV) {
                return notice(T('Noch keine Favoriten', 'No favorites yet'),
                    T('Wähle in Live-TV einen Sender aus, drücke die Menü-/Options-Taste der Fernbedienung und wähle „Zu Favoriten hinzufügen“.',
                        'Select a channel in Live TV, press the menu/options button of the remote and choose "Add to favorites".'),
                    [{ icon: 'live-tv', label: T('Live-TV', 'Live TV'), action: 'content:' + req('tv') }]);
            }
            return tvRoot();
        }
        var now = Date.now();
        var slice = list.slice(offset, offset + CH_PAGE);
        var items = slice.map(function (ch) { return channelItem(ch, now); });
        if (offset + CH_PAGE < list.length) {
            items.push({
                icon: 'msx-white:arrow-forward',
                title: T('Weitere Sender', 'More channels'),
                titleFooter: (offset + CH_PAGE + 1) + '–' + Math.min(list.length, offset + 2 * CH_PAGE),
                action: 'content:' + req('grp:' + enc(key) + ':' + (offset + CH_PAGE)),
            });
        }
        return {
            type: 'list',
            cache: false,
            headline: clean(title) + (offset ? ' (' + (offset + 1) + '–' + Math.min(list.length, offset + CH_PAGE) + ')' : ''),
            extension: list.length + ' ' + T('Sender', 'channels') + ' · {ico:menu} ' + T('Optionen', 'Options'),
            template: CHANNEL_TEMPLATE,
            items: items,
        };
    }

    /** Logo on the left, name and current programme on the right; three channels per row. */
    var CHANNEL_TEMPLATE = {
        type: 'default', layout: '0,0,4,2', color: 'msx-glass', imageFiller: 'fit', imageWidth: 1.3,
        iconSize: 'small', truncation: 'title|titleFooter',
    };

    function programmePanel(id) {
        var ch = tv.byId[id];
        if (!ch) return { headline: '', items: [{ type: 'control', layout: '0,0,8,1', label: T('Sender nicht gefunden', 'Channel not found'), action: 'back' }] };
        var now = Date.now();
        var list = programmes(ch);
        var start = firstEndingAfter(list, now);
        var shown = list.slice(start, start + 40);
        var items = shown.map(function (p) {
            var live = p.start <= now && now < p.stop;
            var item = {
                label: dayTime(p.start) + '  ' + clean(p.title),
                extensionLabel: live ? T('Jetzt', 'Now') : '',
            };
            if (live) {
                item.icon = 'play-arrow';
                item.action = 'video:' + ch.url;
                item.playerLabel = clean(ch.name) + ' – ' + clean(p.title);
            } else if (p.desc) {
                item.icon = 'info';
                item.action = 'panel:data';
                item.data = {
                    headline: dayTime(p.start) + '–' + hhmm(p.stop) + '  ' + clean(p.title),
                    pages: [{
                        items: [
                            { type: 'space', layout: '0,0,8,5', text: clean(p.desc) },
                            { type: 'button', layout: '0,5,8,1', icon: 'arrow-back', label: T('Zurück', 'Back'), action: 'back' },
                        ],
                    }],
                };
            } else {
                item.icon = 'blank';
                item.action = 'back';
            }
            return item;
        });
        if (!items.length) {
            var text = tv.epgLoading ? T('Das Programm wird noch geladen …', 'The guide is still loading …')
                : epgUrl() ? T('Für diesen Sender gibt es keine Programmdaten.', 'There is no guide data for this channel.')
                    : T('Keine EPG-Adresse eingerichtet.', 'No EPG address set up.');
            items.push({ icon: 'info', label: text, action: 'back' });
        }
        return {
            cache: false,
            headline: clean(ch.name),
            template: { type: 'control', layout: '0,0,8,1', enumerate: false },
            items: items,
        };
    }

    // ---------------- Jellyfin pages ----------------

    function jfNotLoggedIn(message) {
        return notice(T('Videothek (Jellyfin)', 'Library (Jellyfin)'),
            message || T('Trage in den Einstellungen deinen Jellyfin-Server, Benutzer und Passwort ein und melde dich an.',
                'Enter your Jellyfin server, user and password in the settings and log in.'),
            [settingsButton()]);
    }

    function jfRoot() {
        if (!jfLoggedIn()) return Promise.resolve(jfNotLoggedIn());
        return jfCall(function () {
            return jfGet('UserViews', { userId: cfg.jfUserId }, 'Users/' + cfg.jfUserId + '/Views');
        }).then(function (r) {
            var views = jfItems(r).filter(function (v) {
                return ['music', 'books', 'photos', 'livetv'].indexOf(String(v.CollectionType || '').toLowerCase()) < 0;
            });
            var items = [
                { icon: 'history', label: T('Weiterschauen', 'Continue watching'), action: 'content:' + req('jfresume') },
                { icon: 'search', label: T('Suchen', 'Search'), action: 'interaction:commit', data: { a: 'jfSearch' } },
            ];
            views.forEach(function (v) {
                var type = String(v.CollectionType || '').toLowerCase();
                items.push({
                    icon: type === 'movies' ? 'movie' : type === 'tvshows' ? 'tv' : 'folder',
                    label: clean(v.Name),
                    action: 'content:' + req('jfl:' + v.Id + ':' + type + ':0'),
                });
            });
            return {
                type: 'list',
                cache: false,
                headline: T('Videothek', 'Library'),
                extension: clean(cfg.jfUser),
                template: { type: 'control', layout: '0,0,6,1', enumerate: false },
                items: items,
            };
        }).catch(function (e) {
            return jfNotLoggedIn(errorText(e));
        });
    }

    function resumePanel(it, label) {
        var ticks = (it.UserData && it.UserData.PlaybackPositionTicks) || 0;
        return {
            headline: label,
            template: { type: 'control', layout: '0,0,8,1', enumerate: false },
            items: [
                { icon: 'play-arrow', label: T('Fortsetzen bei ', 'Resume at ') + jfDuration(ticks), action: 'video:' + jfTranscodeUrl(it, ticks), playerLabel: label },
                { icon: 'replay', label: T('Von vorne abspielen', 'Play from start'), action: 'video:' + jfStreamUrl(it), playerLabel: label },
            ],
        };
    }

    function jfItem(it, landscape) {
        var ud = it.UserData || {};
        var series = it.Type === 'Episode';
        var label = series ? [it.SeriesName, jfEpisodeLabel(it), it.Name].filter(Boolean).join(' · ') : clean(it.Name);
        var item = {
            title: series && !landscape ? clean(it.SeriesName || it.Name) : (series ? jfEpisodeLabel(it) + ' ' : '') + clean(it.Name),
            titleFooter: series && !landscape ? jfEpisodeLabel(it) : (it.ProductionYear ? String(it.ProductionYear) : ''),
        };
        var image = landscape ? jfThumb(it) : jfPoster(it);
        if (image) item.image = image;
        else item.icon = 'msx-white-soft:movie';
        if (jfPlayable(it)) {
            var resumable = !ud.Played && ud.PlaybackPositionTicks > 0;
            item.playerLabel = clean(label);
            if (resumable) {
                item.action = 'panel:data';
                item.data = resumePanel(it, clean(label));
                item.progress = typeof ud.PlayedPercentage === 'number' ? ud.PlayedPercentage / 100 : 0;
            } else {
                item.action = 'video:' + jfStreamUrl(it);
            }
            if (ud.Played) item.tag = '{ico:msx-white:check}';
        } else if (it.Type === 'Series') {
            item.action = 'content:' + req('jfs:' + it.Id);
        } else if (it.Type === 'Season') {
            item.action = 'content:' + req('jfe:' + (it.SeriesId || '') + ':' + it.Id);
        } else {
            item.action = 'content:' + req('jfl:' + it.Id + ':' + String(it.CollectionType || '').toLowerCase() + ':0');
        }
        return item;
    }

    var POSTER_TEMPLATE = { type: 'separate', layout: '0,0,2,4', color: 'msx-glass', imageFiller: 'cover', truncation: 'title|titleFooter' };
    var LANDSCAPE_TEMPLATE = { type: 'separate', layout: '0,0,3,3', color: 'msx-glass', imageFiller: 'cover', truncation: 'title|titleFooter' };

    function jfList(headline, list, landscape, more) {
        if (!list.length) return notice(headline, T('Hier gibt es nichts anzuzeigen.', 'There is nothing to show here.'));
        var items = list.map(function (it) { return jfItem(it, landscape); });
        if (more) items.push(more);
        return {
            type: 'list',
            cache: false,
            headline: clean(headline),
            template: landscape ? LANDSCAPE_TEMPLATE : POSTER_TEMPLATE,
            items: items,
        };
    }

    function jfLibrary(parentId, type, offset) {
        var params = {
            userId: cfg.jfUserId, parentId: parentId, sortBy: 'SortName', sortOrder: 'Ascending',
            startIndex: String(offset), limit: String(JF_PAGE), fields: JF_FIELDS, enableTotalRecordCount: 'true',
        };
        if (type === 'movies') {
            params.includeItemTypes = 'Movie';
            params.recursive = 'true';
        } else if (type === 'tvshows') {
            params.includeItemTypes = 'Series';
            params.recursive = 'true';
        } else if (type === 'boxsets') {
            params.includeItemTypes = 'BoxSet';
            params.recursive = 'true';
        }
        var legacy = {};
        for (var k in params) if (k !== 'userId') legacy[k.charAt(0).toUpperCase() + k.substring(1)] = params[k];
        return Promise.all([
            jfCall(function () { return jfGet('Items', params, 'Users/' + cfg.jfUserId + '/Items', legacy); }),
            jfCall(function () { return jfGet('Items/' + parentId, { userId: cfg.jfUserId }, 'Users/' + cfg.jfUserId + '/Items/' + parentId); }).catch(function () { return null; }),
        ]).then(function (r) {
            var list = jfItems(r[0]);
            var total = (r[0] && r[0].TotalRecordCount) || 0;
            var name = (r[1] && r[1].Name) || T('Videothek', 'Library');
            var more = offset + JF_PAGE < total ? {
                icon: 'msx-white:arrow-forward',
                title: T('Mehr laden', 'Load more'),
                titleFooter: (offset + JF_PAGE + 1) + '–' + Math.min(total, offset + 2 * JF_PAGE) + ' / ' + total,
                action: 'content:' + req('jfl:' + parentId + ':' + type + ':' + (offset + JF_PAGE)),
            } : null;
            return jfList(name + (offset ? ' (' + (offset + 1) + '–' + Math.min(total, offset + JF_PAGE) + ')' : ''), list, false, more);
        });
    }

    function jfSeasons(seriesId) {
        return Promise.all([
            jfCall(function () { return jfRequest('GET', 'Shows/' + seriesId + '/Seasons', { userId: cfg.jfUserId, fields: JF_FIELDS }); }),
            jfCall(function () { return jfGet('Items/' + seriesId, { userId: cfg.jfUserId }, 'Users/' + cfg.jfUserId + '/Items/' + seriesId); }).catch(function () { return null; }),
        ]).then(function (r) {
            var seasons = jfItems(r[0]);
            var name = (r[1] && r[1].Name) || '';
            // A series with only one season opens its episodes directly.
            if (seasons.length === 1) return jfEpisodes(seriesId, seasons[0].Id);
            return jfList(name, seasons.map(function (s) {
                if (!s.SeriesId) s.SeriesId = seriesId;
                return s;
            }), false);
        });
    }

    function jfEpisodes(seriesId, seasonId) {
        return jfCall(function () {
            return jfRequest('GET', 'Shows/' + seriesId + '/Episodes', { userId: cfg.jfUserId, seasonId: seasonId, fields: JF_FIELDS });
        }).then(function (r) {
            var list = jfItems(r);
            var name = list[0] ? [list[0].SeriesName, list[0].SeasonName].filter(Boolean).join(' · ') : '';
            return jfList(name, list, true);
        });
    }

    function jfResume() {
        return jfCall(function () {
            return jfGet('UserItems/Resume', { userId: cfg.jfUserId, limit: '40', mediaTypes: 'Video', fields: JF_FIELDS },
                'Users/' + cfg.jfUserId + '/Items/Resume', { Limit: '40', MediaTypes: 'Video', Fields: JF_FIELDS });
        }).then(function (r) {
            return jfList(T('Weiterschauen', 'Continue watching'), jfItems(r), true);
        });
    }

    function jfSearch(term) {
        return jfCall(function () {
            return jfGet('Items', {
                userId: cfg.jfUserId, searchTerm: term, includeItemTypes: 'Movie,Series,Episode', recursive: 'true', limit: '100', fields: JF_FIELDS,
            }, 'Users/' + cfg.jfUserId + '/Items', {
                SearchTerm: term, IncludeItemTypes: 'Movie,Series,Episode', Recursive: 'true', Limit: '100', Fields: JF_FIELDS,
            });
        }).then(function (r) {
            return jfList('{ico:search} ' + clean(term), jfItems(r), false);
        });
    }

    // ---------------- Settings & on-screen keyboard ----------------

    var FIELD_LABELS = {
        m3uUrl: function () { return T('Playlist-Adresse (M3U)', 'Playlist address (M3U)'); },
        epgUrl: function () { return T('EPG-Adresse (XMLTV)', 'EPG address (XMLTV)'); },
        jfUrl: function () { return T('Jellyfin-Server', 'Jellyfin server'); },
        jfUser: function () { return T('Benutzer', 'User'); },
        jfPass: function () { return T('Passwort', 'Password'); },
    };

    function shiftLabel(h) {
        return (h > 0 ? '+' : '') + h + ' h';
    }

    function settingsRoot() {
        var shiftItems = [];
        for (var h = -6; h <= 6; h++) {
            shiftItems.push({
                label: shiftLabel(h),
                focus: h === (cfg.epgShift || 0),
                extensionIcon: h === (cfg.epgShift || 0) ? 'check' : 'blank',
                action: '[back|interaction:commit]',
                data: { a: 'shift', h: h },
            });
        }
        var epgExt = cfg.epgUrl ? shortUrl(cfg.epgUrl) : (tv.epgHints[0] ? T('aus der Playlist', 'from the playlist') : T('nicht gesetzt', 'not set'));
        var jfStatus = jfLoggedIn() ? T('angemeldet', 'logged in') : T('nicht angemeldet', 'not logged in');
        var items = [
            control('0,0,12,1', 'playlist-play', FIELD_LABELS.m3uUrl(), shortUrl(cfg.m3uUrl) || T('nicht gesetzt', 'not set'), { a: 'edit', f: 'm3uUrl' }),
            control('0,1,12,1', 'event', FIELD_LABELS.epgUrl(), epgExt, { a: 'edit', f: 'epgUrl' }),
            {
                type: 'control', layout: '0,2,6,1', icon: 'schedule', label: T('EPG-Zeitversatz', 'EPG time shift'),
                extensionLabel: shiftLabel(cfg.epgShift || 0), action: 'panel:data',
                data: { headline: T('EPG-Zeitversatz', 'EPG time shift'), template: { type: 'control', layout: '0,0,8,1', enumerate: false }, items: shiftItems },
            },
            control('6,2,6,1', 'refresh', T('Neu laden', 'Reload'), tvStatus(), { a: 'reloadTv' }),
            control('0,3,12,1', 'dns', FIELD_LABELS.jfUrl(), cfg.jfUrl || T('nicht gesetzt', 'not set'), { a: 'edit', f: 'jfUrl' }),
            control('0,4,6,1', 'person', FIELD_LABELS.jfUser(), clean(cfg.jfUser) || '–', { a: 'edit', f: 'jfUser' }),
            control('6,4,6,1', 'password', FIELD_LABELS.jfPass(), cfg.jfPass ? '••••••' : '–', { a: 'edit', f: 'jfPass' }),
            jfLoggedIn()
                ? control('0,5,6,1', 'logout', T('Jellyfin abmelden', 'Log out of Jellyfin'), jfStatus, { a: 'jfLogout' })
                : control('0,5,6,1', 'login', T('Bei Jellyfin anmelden', 'Log in to Jellyfin'), jfStatus, { a: 'jfLogin' }),
            control('6,5,6,1', 'translate', T('Sprache', 'Language'), cfg.lang === 'en' ? 'English' : 'Deutsch', { a: 'lang' }),
        ];
        return { type: 'pages', cache: false, headline: T('Einstellungen', 'Settings'), extension: 'Kasy TV ' + VERSION, pages: [{ items: items }] };
    }

    var kb = null;
    var KB_ROWS = [
        'abcdefghijkl'.split(''),
        'mnopqrstuvwx'.split(''),
        'yz0123456789'.split(''),
        ['.', ':', '/', '-', '_', '?', '=', '&', '%', '@', '~', '+'],
    ];

    function openKeyboard(o) {
        kb = { title: o.title, value: o.value || '', secret: !!o.secret, shift: false, show: !o.secret, onSave: o.onSave };
        exec('content:' + req('kb'));
    }

    function keyboardPage() {
        if (!kb) return notice(T('Eingabe', 'Input'), '', []);
        var shown = kb.secret && !kb.show ? new Array(kb.value.length + 1).join('•') : kb.value;
        if (shown.length > 56) shown = '…' + shown.substring(shown.length - 55);
        var items = [];
        KB_ROWS.forEach(function (row, y) {
            row.forEach(function (ch, x) {
                var c = kb.shift ? ch.toUpperCase() : ch;
                items.push({ type: 'button', layout: x + ',' + y + ',1,1', label: c, action: 'interaction:commit', data: { a: 'key', k: c } });
            });
        });
        function wide(x, y, w, label, data, icon) {
            // Buttons show either an icon or a label – the icon goes into the label as inline expression.
            var text = icon ? (label ? '{ico:' + icon + '} ' + label : '{ico:' + icon + '}') : label;
            items.push({ type: 'button', layout: x + ',' + y + ',' + w + ',1', label: text, action: data ? 'interaction:commit' : 'back', data: data });
        }
        wide(0, 4, 2, kb.shift ? 'abc' : 'ABC', { a: 'key', k: 'shift' }, 'keyboard-capslock');
        wide(2, 4, 2, 'http://', { a: 'key', k: 'http://' });
        wide(4, 4, 2, 'https://', { a: 'key', k: 'https://' });
        wide(6, 4, 2, '.m3u', { a: 'key', k: '.m3u' });
        wide(8, 4, 2, ':8096', { a: 'key', k: ':8096' });
        if (kb.secret) wide(10, 4, 2, kb.show ? T('Verbergen', 'Hide') : T('Zeigen', 'Show'), { a: 'key', k: 'show' }, 'visibility');
        else wide(10, 4, 2, 'www.', { a: 'key', k: 'www.' });
        wide(0, 5, 2, '', { a: 'key', k: 'bs' }, 'backspace');
        wide(2, 5, 2, '', { a: 'key', k: 'clr' }, 'clear');
        wide(4, 5, 2, '', { a: 'key', k: ' ' }, 'space-bar');
        wide(6, 5, 3, T('Abbrechen', 'Cancel'), null, 'close');
        wide(9, 5, 3, T('Übernehmen', 'Apply'), { a: 'kbSave' }, 'done');
        return {
            type: 'pages',
            cache: false,
            headline: clean(kb.title) + ':  ' + (shown ? clean(shown) : '') + '_',
            pages: [{ items: items }],
        };
    }

    function onKey(k) {
        if (k === 'shift') kb.shift = !kb.shift;
        else if (k === 'show') kb.show = !kb.show;
        else if (k === 'bs') kb.value = kb.value.substring(0, kb.value.length - 1);
        else if (k === 'clr') kb.value = '';
        else if (kb.value.length < 1024) kb.value += k;
        exec('reload:content');
    }

    function editField(f) {
        openKeyboard({
            title: FIELD_LABELS[f](),
            value: cfg[f],
            secret: f === 'jfPass',
            onSave: function (v) {
                v = v.trim();
                var changed = cfg[f] !== v;
                cfg[f] = v;
                if (changed && (f === 'jfUrl' || f === 'jfUser' || f === 'jfPass')) {
                    cfg.jfToken = '';
                    cfg.jfUserId = '';
                }
                saveCfg();
                exec('[back|reload:content]');
                if (!changed) return;
                if (f === 'm3uUrl') {
                    tv.loaded = false;
                    rawEpg = null;
                    tv.epg = {};
                    tv.epgMapped = 0;
                    loadPlaylist().then(function () { notifyTv(); });
                } else if (f === 'epgUrl') {
                    rawEpg = null;
                    tv.epg = {};
                    tv.epgMapped = 0;
                    loadEpg();
                }
            },
        });
    }

    function notifyTv() {
        if (tv.error) exec('error:' + clean(tv.error));
        else exec('success:' + tv.channels.length + ' ' + T('Sender geladen', 'channels loaded'));
    }

    // ---------------- Commands from MSX (interaction:commit) ----------------

    function onCommand(d) {
        switch (d.a) {
            case 'fav':
                var i = cfg.favorites.indexOf(d.id);
                if (i >= 0) cfg.favorites.splice(i, 1);
                else cfg.favorites.push(d.id);
                saveCfg();
                exec('[reload:content|info:' + (i >= 0 ? T('Aus Favoriten entfernt', 'Removed from favorites') : T('Zu Favoriten hinzugefügt', 'Added to favorites')) + ']');
                break;
            case 'reloadTv':
                tv.loaded = false;
                rawEpg = null;
                tv.epg = {};
                tv.epgMapped = 0;
                exec('info:' + T('Playlist wird geladen …', 'Loading playlist …'));
                loadPlaylist().then(function () {
                    notifyTv();
                    exec('reload:content');
                });
                break;
            case 'shift':
                cfg.epgShift = d.h;
                saveCfg();
                mapEpg();
                exec('reload:content');
                break;
            case 'edit':
                editField(d.f);
                break;
            case 'key':
                if (kb) onKey(d.k);
                break;
            case 'kbSave':
                if (kb) {
                    var cb = kb.onSave;
                    var value = kb.value;
                    kb = null;
                    cb(value);
                }
                break;
            case 'jfLogin':
                exec('info:' + T('Anmeldung läuft …', 'Logging in …'));
                jfLogin().then(function () {
                    exec('[reload:content|success:' + T('Bei Jellyfin angemeldet', 'Logged in to Jellyfin') + ']');
                }).catch(function (e) {
                    exec('error:' + clean(errorText(e)));
                });
                break;
            case 'jfLogout':
                cfg.jfToken = '';
                cfg.jfUserId = '';
                saveCfg();
                exec('reload:content');
                break;
            case 'jfSearch':
                openKeyboard({
                    title: T('Suche', 'Search'),
                    value: '',
                    onSave: function (v) {
                        v = v.trim();
                        exec(v ? '[back|content:' + req('jfq:' + enc(v)) + ']' : 'back');
                    },
                });
                break;
            case 'lang':
                cfg.lang = cfg.lang === 'en' ? 'de' : 'en';
                saveCfg();
                exec('reload');
                break;
        }
    }

    // ---------------- Request routing ----------------

    var boot = null;

    function route(dataId) {
        var parts = dataId.split(':');
        var id = parts[0];
        switch (id) {
            case 'init':
                return Promise.resolve(menuRoot());
            case 'tv':
                return whenTvReady().then(tvRoot);
            case 'grp':
                return whenTvReady().then(function () { return whenEpgReady(5000); }).then(function () {
                    if (!cfg.m3uUrl || (tv.error && !tv.channels.length)) return tvRoot();
                    return groupPage(decodeURIComponent(parts[1] || ALL), parseInt(parts[2], 10) || 0);
                });
            case 'epg':
                return whenTvReady().then(function () { return whenEpgReady(8000); }).then(function () {
                    return programmePanel(decodeURIComponent(parts[1] || ''));
                });
            case 'jf':
                return jfRoot();
        }
        if (id.indexOf('jf') === 0 && !jfLoggedIn()) return Promise.resolve(jfNotLoggedIn());
        switch (id) {
            case 'jfresume':
                return jfResume();
            case 'jfl':
                return jfLibrary(parts[1], parts[2] || '', parseInt(parts[3], 10) || 0);
            case 'jfs':
                return jfSeasons(parts[1]);
            case 'jfe':
                return jfEpisodes(parts[1], parts[2]);
            case 'jfq':
                return jfSearch(decodeURIComponent(parts[1] || ''));
            case 'settings':
                return Promise.resolve(settingsRoot());
            case 'kb':
                return Promise.resolve(keyboardPage());
        }
        return Promise.resolve(null);
    }

    function start() {
        if (boot) return boot;
        boot = detectProxy().then(loadConfigFile).then(function () {
            restoreChannels();
            if (!cfg.m3uUrl) return;
            // Cached channels are shown at once; older than 6 hours → refresh in the background.
            if (tv.loaded) {
                if (Date.now() - tv.updatedAt > 6 * 3600000) loadPlaylist();
                else loadEpg();
            } else {
                loadPlaylist();
            }
        });
        return boot;
    }

    function KasyHandler() {}

    KasyHandler.prototype.init = function () {
        start();
    };

    KasyHandler.prototype.ready = function () {};

    KasyHandler.prototype.handleEvent = function () {};

    KasyHandler.prototype.handleData = function (data) {
        var d = data && data.data;
        if (!d || !d.a) return;
        try {
            onCommand(d);
        } catch (e) {
            TVXInteractionPlugin.error(errorText(e));
        }
    };

    KasyHandler.prototype.handleRequest = function (dataId, data, callback) {
        start().then(function () {
            return route(String(dataId || ''));
        }).then(function (result) {
            callback(result);
        }, function (e) {
            callback(notice(T('Fehler', 'Error'), errorText(e), []));
        });
    };

    KasyHandler.prototype.onError = function () {};

    window.KasyMsx = { route: route, start: start, cfg: cfg, tv: tv };

    if (window.TVXPluginTools) {
        TVXPluginTools.onReady(function () {
            TVXInteractionPlugin.setupHandler(new KasyHandler());
            TVXInteractionPlugin.init();
        });
    }
})();
