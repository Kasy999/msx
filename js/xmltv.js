"use strict";
/**
 * Streaming XMLTV parser (plain and gzip, several hundred MB) – port of XmltvParser.kt.
 * The download is read chunk by chunk (fetch stream; gzip via pako), so the whole file never has to fit
 * into the TV's memory. Only programmes of accepted channels inside the time window are kept.
 */
var Xmltv = (function () {
    var nonAlnum = /[^a-z0-9]/g;
    var qualitySuffix = /(uhd|fhd|hd|sd|4k|hevc|h265|50fps|orig)+$/;

    function normalizeName(name) {
        return String(name || '').toLowerCase().replace(nonAlnum, '').replace(qualitySuffix, '');
    }

    /** XMLTV time: "yyyyMMddHHmmss +ZZZZ" (offset and seconds optional). */
    function parseTime(v) {
        if (!v || v.length < 12) return 0;
        v = v.trim();
        var year = +v.substring(0, 4);
        var month = +v.substring(4, 6);
        var day = +v.substring(6, 8);
        var hour = +v.substring(8, 10);
        var minute = +v.substring(10, 12);
        var second = (v.length >= 14 && /\d/.test(v.charAt(12))) ? +v.substring(12, 14) : 0;
        var ms = Date.UTC(year, month - 1, day, hour, minute, second);
        var sp = v.indexOf(' ');
        var tz = sp >= 0 ? v.substring(sp + 1).trim() : '';
        if (tz.length >= 5 && (tz.charAt(0) === '+' || tz.charAt(0) === '-')) {
            var off = (+tz.substring(1, 3)) * 3600000 + (+tz.substring(3, 5)) * 60000;
            ms -= tz.charAt(0) === '-' ? -off : off;
        }
        return ms;
    }

    function attr(tag, name) {
        var re = new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')');
        var m = re.exec(tag);
        if (!m) return null;
        return U.decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    }

    function elementText(block, name) {
        var open = block.indexOf('<' + name);
        if (open < 0) return null;
        var gt = block.indexOf('>', open);
        if (gt < 0) return null;
        if (block.charAt(gt - 1) === '/') return '';
        var close = block.indexOf('</' + name + '>', gt);
        if (close < 0) return null;
        var text = block.substring(gt + 1, close);
        if (text.indexOf('<![CDATA[') >= 0) text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
        return U.decodeEntities(text.trim());
    }

    /**
     * Incremental parser: feed(text) with consecutive chunks, then finish().
     * filter: { fromMs, toMs, acceptChannel(id, displayNames) }
     */
    function Parser(filter) {
        this.filter = filter;
        this.buf = '';
        this.programs = {};
        this.displayNames = {};
        this.channelNames = {};
        this.accepted = {};
        this.count = 0;
    }

    Parser.prototype.feed = function (text) {
        var buf = this.buf + text;
        var pos = 0;
        // Next tag positions are only searched again once passed (-1 = none left in this buffer), so the
        // channel section at the start doesn't make every programme scan the whole remaining buffer.
        var p = buf.indexOf('<programme', 0);
        var c = buf.indexOf('<channel', 0);
        for (;;) {
            if (p >= 0 && p < pos) p = buf.indexOf('<programme', pos);
            if (c >= 0 && c < pos) c = buf.indexOf('<channel', pos);
            var start;
            var isProgramme;
            if (p < 0 && c < 0) {
                // Keep a short tail: a tag may be split between two chunks.
                pos = Math.max(pos, buf.length - 16);
                break;
            }
            if (c >= 0 && (p < 0 || c < p)) {
                start = c;
                isProgramme = false;
            } else {
                start = p;
                isProgramme = true;
            }
            var closeTag = isProgramme ? '</programme>' : '</channel>';
            var end = buf.indexOf(closeTag, start);
            if (end < 0) {
                // Self-closing element without content.
                var gt = buf.indexOf('>', start);
                if (gt > 0 && buf.charAt(gt - 1) === '/') {
                    pos = gt + 1;
                    continue;
                }
                pos = start;
                break;
            }
            var block = buf.substring(start, end);
            if (isProgramme) this.programme(block);
            else this.channel(block);
            pos = end + closeTag.length;
        }
        this.buf = buf.substring(pos);
    };

    Parser.prototype.channel = function (block) {
        var tagEnd = block.indexOf('>');
        var id = attr(block.substring(0, tagEnd + 1), 'id');
        if (!id) return;
        var names = this.channelNames[id] || (this.channelNames[id] = []);
        var re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
        var m;
        while ((m = re.exec(block)) !== null) {
            var name = U.decodeEntities(m[1].trim());
            if (!name) continue;
            names.push(name);
            var key = normalizeName(name);
            if (this.displayNames[key] === undefined) this.displayNames[key] = id;
        }
    };

    Parser.prototype.programme = function (block) {
        var tagEnd = block.indexOf('>');
        var tag = block.substring(0, tagEnd + 1);
        var ch = attr(tag, 'channel');
        if (!ch) return;
        var start = parseTime(attr(tag, 'start'));
        var stop = parseTime(attr(tag, 'stop'));
        if (stop <= start) stop = start + 30 * 60000;
        var f = this.filter;
        if (stop < f.fromMs || start > f.toMs) return;
        var ok = this.accepted[ch];
        if (ok === undefined) ok = this.accepted[ch] = f.acceptChannel(ch, this.channelNames[ch] || []);
        if (!ok) return;
        var title = elementText(block, 'title') || '—';
        var desc = elementText(block, 'desc');
        var cat = elementText(block, 'category');
        var list = this.programs[ch] || (this.programs[ch] = []);
        // Compact form: [start, stop, title, description, category]
        list.push([start, stop, title, desc || null, cat || null]);
        this.count++;
    };

    Parser.prototype.finish = function () {
        var programs = this.programs;
        for (var k in programs) {
            if (!Object.prototype.hasOwnProperty.call(programs, k)) continue;
            var list = programs[k];
            list.sort(function (a, b) { return a[0] - b[0]; });
            // Remove duplicates/overlaps some providers produce.
            var cleaned = [];
            for (var i = 0; i < list.length; i++) {
                if (!cleaned.length || list[i][0] >= cleaned[cleaned.length - 1][0] + 1) cleaned.push(list[i]);
            }
            programs[k] = cleaned;
        }
        return { programs: programs, displayNames: this.displayNames, count: this.count };
    };

    /**
     * Downloads and parses [url]. Resolves to { programs: { xmltvId: [[start, stop, title, desc, cat]] },
     * displayNames: { normalized: xmltvId }, count }.
     */
    function load(url, filter, onProgress) {
        var parser = new Parser(filter);
        var decoder = new TextDecoder('utf-8');
        var received = 0;

        function feedBytes(bytes) {
            var text = decoder.decode(bytes, { stream: true });
            if (text) parser.feed(text);
        }

        return fetch(url, { cache: 'no-store' }).then(function (response) {
            if (!response.ok) throw new Error(TvS.httpRejected(response.status));
            var gunzip = null;
            var first = true;

            function handle(chunk) {
                received += chunk.length;
                if (onProgress) onProgress(received);
                if (first) {
                    first = false;
                    if (chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
                        gunzip = new pako.Inflate();
                        gunzip.onData = function (out) { feedBytes(out); };
                    }
                }
                if (gunzip) {
                    gunzip.push(chunk, false);
                    if (gunzip.err) throw new Error('gzip: ' + gunzip.msg);
                } else {
                    feedBytes(chunk);
                }
            }

            function done() {
                if (gunzip) gunzip.push(new Uint8Array(0), true);
                var rest = decoder.decode();
                if (rest) parser.feed(rest);
                return parser.finish();
            }

            if (response.body && response.body.getReader) {
                var reader = response.body.getReader();
                var pump = function () {
                    return reader.read().then(function (r) {
                        if (r.done) return done();
                        handle(r.value);
                        return pump();
                    });
                };
                return pump();
            }
            // Old engines without fetch streams: whole file at once.
            return response.arrayBuffer().then(function (buf) {
                var all = new Uint8Array(buf);
                var size = 1 << 20;
                for (var i = 0; i < all.length; i += size) handle(all.subarray(i, Math.min(all.length, i + size)));
                return done();
            });
        });
    }

    return { load: load, normalizeName: normalizeName, parseTime: parseTime };
})();
