"use strict";
/**
 * Robust M3U / M3U8 (extended) playlist parser – port of M3uParser.kt.
 *
 * Supports #EXTM3U header attributes (url-tvg, x-tvg-url, catchup, catchup-source, catchup-days, tvg-shift),
 * #EXTINF attributes (tvg-id, tvg-name, tvg-logo, tvg-chno, group-title, tvg-shift, catchup*, timeshift, tvg-rec),
 * #EXTGRP and plain M3U files without #EXTINF.
 *
 * HTTP headers of the playlist (#EXTVLCOPT, #KODIPROP, #EXTHTTP, "url|User-Agent=…") are read but cannot be
 * applied: the TV browsers do not allow setting User-Agent/Referer for video streams.
 */
var CatchupType = {
    NONE: 'NONE',
    DEFAULT: 'DEFAULT',
    APPEND: 'APPEND',
    SHIFT: 'SHIFT',
    FLUSSONIC: 'FLUSSONIC',
    FLUSSONIC_HLS: 'FLUSSONIC_HLS',
    FLUSSONIC_TS: 'FLUSSONIC_TS',
    XTREAM: 'XTREAM',
    VOD: 'VOD',
    parse: function (raw) {
        switch (String(raw || '').trim().toLowerCase()) {
            case 'default': return 'DEFAULT';
            case 'append': return 'APPEND';
            case 'shift':
            case 'timeshift': return 'SHIFT';
            case 'flussonic':
            case 'fs': return 'FLUSSONIC';
            case 'flussonic-hls': return 'FLUSSONIC_HLS';
            case 'flussonic-ts':
            case 'fs-ts': return 'FLUSSONIC_TS';
            case 'xc':
            case 'xtream':
            case 'xtream-codes': return 'XTREAM';
            case 'vod': return 'VOD';
            default: return null;
        }
    },
};

var Channels = {
    ALL: '__all',
    FAVORITES: '__favorites',
    ARCHIVE: '__archive',
    CUSTOM_PREFIX: 'custom:',
    hasArchive: function (ch) {
        return ch.catchup.type !== 'NONE' && ch.catchup.days > 0;
    },
};

var M3uParser = (function () {
    var attrRegex = /([A-Za-z0-9_\-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s,]+))/g;
    var xtreamRegex = /^(https?:\/\/[^\/]+)\/(?:live\/)?([^\/]+)\/([^\/]+)\/(\d+)(\.[A-Za-z0-9]+)?(\?.*)?$/;

    function parseAttributes(text) {
        var map = {};
        var m;
        attrRegex.lastIndex = 0;
        while ((m = attrRegex.exec(text)) !== null) {
            var value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : ''));
            map[m[1].toLowerCase()] = value.trim();
        }
        return map;
    }

    /** The comma that separates the attribute list from the display name (ignores commas in quotes). */
    function findTitleComma(body) {
        var quote = null;
        for (var i = 0; i < body.length; i++) {
            var c = body.charAt(i);
            if (quote !== null && c === quote) quote = null;
            else if (quote === null && (c === '"' || c === "'")) quote = c;
            else if (quote === null && c === ',') return i;
        }
        return -1;
    }

    function toInt(v) {
        var n = parseInt(v, 10);
        return isNaN(n) ? null : n;
    }

    function toFloat(v) {
        var n = parseFloat(v);
        return isNaN(n) ? null : n;
    }

    function buildChannel(info, rawUrl, groupOverride, number, usedIds, global) {
        var body = info.indexOf(':') >= 0 ? info.substring(info.indexOf(':') + 1) : '';
        var comma = findTitleComma(body);
        var attrPart = comma >= 0 ? body.substring(0, comma) : body;
        var title = comma >= 0 ? body.substring(comma + 1).trim() : '';
        var attrs = parseAttributes(attrPart);

        var url = rawUrl.split('|')[0].trim();
        var name = title || attrs['tvg-name'] || ('Channel ' + number);
        var tvgId = attrs['tvg-id'] && attrs['tvg-id'].trim() ? attrs['tvg-id'] : null;
        var groupRaw = groupOverride !== null ? groupOverride : attrs['group-title'];
        var group = groupRaw ? groupRaw.split(';')[0].trim() : '';
        if (!group) group = 'Uncategorized';

        var days = toInt(attrs['catchup-days'] !== undefined ? attrs['catchup-days'] : (attrs.timeshift !== undefined ? attrs.timeshift : attrs['tvg-rec']));
        if (days === null) days = global.days;
        var source = attrs['catchup-source'] !== undefined ? attrs['catchup-source'] : global.source;
        var explicitType = CatchupType.parse(attrs.catchup !== undefined ? attrs.catchup : attrs['catchup-type']);
        if (!explicitType && global.type && global.type !== 'NONE') explicitType = global.type;
        var type;
        if (explicitType) type = explicitType;
        else if (days > 0 && source && source.trim()) type = 'DEFAULT';
        else if (days > 0 && xtreamRegex.test(url)) type = 'XTREAM';
        else if (days > 0) type = 'SHIFT';
        else type = 'NONE';
        // Many providers announce catch-up but omit the days -> assume a week.
        var effectiveDays = (type !== 'NONE' && days <= 0) ? 7 : days;

        var baseId = (tvgId || name).toLowerCase().trim();
        var id = baseId;
        var suffix = 2;
        while (usedIds[id]) id = baseId + '#' + (suffix++);
        usedIds[id] = true;

        var shift = toFloat(attrs['tvg-shift']);
        return {
            id: id,
            number: toInt(attrs['tvg-chno']) || number,
            name: name,
            url: url,
            logo: attrs['tvg-logo'] && attrs['tvg-logo'].trim() ? attrs['tvg-logo'] : null,
            group: group,
            tvgId: tvgId,
            tvgName: attrs['tvg-name'] && attrs['tvg-name'].trim() ? attrs['tvg-name'] : null,
            catchup: { type: type, source: source && source.trim() ? source : null, days: effectiveDays },
            tvgShiftHours: shift !== null ? shift : global.shift,
        };
    }

    function parse(text) {
        var channels = [];
        var epgUrls = [];
        var usedIds = {};
        var global = { type: null, source: null, days: 0, shift: 0 };
        var pendingInfo = null;
        var pendingGroup = null;
        var lines = text.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.charCodeAt(0) === 0xFEFF) line = line.substring(1);
            if (!line) continue;
            var upper = line.substring(0, 12).toUpperCase();
            if (upper.indexOf('#EXTM3U') === 0) {
                var attrs = parseAttributes(line.substring(7));
                var tvg = attrs['url-tvg'] || attrs['x-tvg-url'] || attrs['tvg-url'];
                if (tvg) {
                    tvg.split(',').forEach(function (u) {
                        u = u.trim();
                        if (u && epgUrls.indexOf(u) < 0) epgUrls.push(u);
                    });
                }
                global.type = CatchupType.parse(attrs.catchup !== undefined ? attrs.catchup : attrs['catchup-type']);
                global.source = attrs['catchup-source'] || null;
                global.days = toInt(attrs['catchup-days'] !== undefined ? attrs['catchup-days'] : attrs.timeshift) || 0;
                global.shift = toFloat(attrs['tvg-shift']) || 0;
            } else if (upper.indexOf('#EXTINF') === 0) {
                pendingInfo = line;
            } else if (upper.indexOf('#EXTGRP:') === 0) {
                pendingGroup = line.substring(line.indexOf(':') + 1).trim();
            } else if (line.charAt(0) === '#') {
                // other directives (#EXTVLCOPT, #KODIPROP, #EXT-X-*, comments) are ignored
            } else {
                if (pendingInfo !== null) {
                    channels.push(buildChannel(pendingInfo, line, pendingGroup, channels.length + 1, usedIds, global));
                } else if (line.indexOf('://') >= 0) {
                    var last = line.substring(line.lastIndexOf('/') + 1).split('?')[0];
                    channels.push(buildChannel('#EXTINF:-1,' + last, line, pendingGroup, channels.length + 1, usedIds, { type: null, source: null, days: 0, shift: global.shift }));
                }
                pendingInfo = null;
                pendingGroup = null;
            }
        }
        return { channels: channels, epgUrls: epgUrls };
    }

    return { parse: parse, xtreamRegex: xtreamRegex };
})();
