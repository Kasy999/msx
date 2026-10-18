"use strict";
/**
 * The few helpers m3u.js / xmltv.js (shared with the Tizen/webOS app) expect from the app's util.js and i18n.
 */
var U = {
    decodeEntities: function (s) {
        if (!s || s.indexOf('&') < 0) return s;
        return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, e) {
            var l = e.toLowerCase();
            if (l === 'amp') return '&';
            if (l === 'lt') return '<';
            if (l === 'gt') return '>';
            if (l === 'quot') return '"';
            if (l === 'apos') return "'";
            var code = l.charAt(1) === 'x' ? parseInt(l.substring(2), 16) : parseInt(l.substring(1), 10);
            return isNaN(code) ? m : String.fromCharCode(code);
        });
    },
};

var TvS = {
    httpRejected: function (status) { return 'HTTP ' + status; },
};
