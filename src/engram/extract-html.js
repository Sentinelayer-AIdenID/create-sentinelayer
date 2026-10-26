/**
 * ENGRAM §EW04 — HTML/JSON-LD extraction with byte offsets.
 *
 * Pure extractor: takes bytes of an HTML page and returns structured facts
 * (title, description, canonical, headings, links, JSON-LD) with byte-level
 * evidence pointing back into the source. Unparseable JSON-LD becomes an
 * `unverified` item, never a guess. All extracted items are labelled
 * `epistemicType: "extracted"`, distinct from `"api"`.
 *
 * Works entirely in UTF-8 byte offsets — never uses JavaScript string indices.
 *
 * Library only. Node builtins only. No new dependency. No DOM, no JS execution.
 */


/** Unicode-whitespace test — same as /\s/ — for whitespace collapse. */
const WS_RE = /\s/;

// ---------------------------------------------------------------------------
// Buffer search helpers (byte-level, not string-level)
// ---------------------------------------------------------------------------

function indexOf(buf, needle, start = 0) {
  return buf.indexOf(needle, start);
}

function indexOfStr(buf, str, start = 0) {
  return buf.indexOf(Buffer.from(str, "utf-8"), start);
}

// ---------------------------------------------------------------------------
// Lightweight HTML tag-aware scanner (byte-level)
// ---------------------------------------------------------------------------

/**
 * Find the first '>' outside of single- and double-quoted attribute values.
 * Returns byte position of '>', or -1 if not found.
 */
function findGtOutsideQuotes(bytes, start, limit) {
  const bufLen = bytes.length;
  const end = limit !== undefined && limit < bufLen ? limit : bufLen;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b === 0x22) { // double quote
      for (i++; i < end; i++) {
        if (bytes[i] === 0x22) break;
      }
      continue;
    }
    if (b === 0x27) { // single quote
      for (i++; i < end; i++) {
        if (bytes[i] === 0x27) break;
      }
      continue;
    }
    if (b === 0x3e) return i; // '>'
  }
  return -1;
}

/**
 * Parse attributes from a tag's inner text into a Map of lowercased name -> value.
 * Handles unquoted, single-quoted, and double-quoted values.
 */
function parseAttrs(inner) {
  const attrs = new Map();
  let i = 0;
  const len = inner.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(inner[i])) i++;
    if (i >= len) break;

    // Find end of attribute name — scan until whitespace, '=', or end
    let nameEnd = i;
    while (nameEnd < len && !/\s/.test(inner[nameEnd]) && inner[nameEnd] !== '=') nameEnd++;
    const name = inner.slice(i, nameEnd).toLowerCase();
    i = nameEnd;

    // Skip ASCII whitespace between name and possible '='
    while (i < len && /\s/.test(inner[i])) i++;

    if (i < len && inner[i] === '=') {
      // '=' found: read the value
      i++; // skip '='
      // Skip whitespace after =
      while (i < len && /\s/.test(inner[i])) i++;

      if (i >= len) {
        if (name.length > 0) { if (!attrs.has(name)) attrs.set(name, ''); }
        break;
      }

      if (inner[i] === '"' || inner[i] === "'") {
        const quote = inner[i];
        i++;
        let valStart = i;
        while (i < len && inner[i] !== quote) {
          i++;
        }
        const value = inner.slice(valStart, i);
        if (name.length > 0) { if (!attrs.has(name)) attrs.set(name, value); }
        if (i < len) i++; // skip closing quote
      } else {
        // Unquoted value
        let valStart = i;
        while (i < len && !/\s/.test(inner[i])) i++;
        const value = inner.slice(valStart, i);
        if (name.length > 0) { if (!attrs.has(name)) attrs.set(name, value); }
      }
    } else {
      // No '=': valueless attribute
      if (name.length > 0) { if (!attrs.has(name)) attrs.set(name, ''); }
    }
  }

  return attrs;
}

/**
 * Find the next HTML tag starting at or after `pos` (byte position).
 * Returns { tagName, start, end, selfClosing, raw, attrs, comment, unclosed? } or null.
 */
function nextTag(bytes, pos) {
  const lt = indexOfStr(bytes, "<", pos);
  if (lt === -1) return null;

  // Check for <!DOCTYPE, <!--, <![CDATA[, <!> etc before scanning for >
  if (lt + 1 < bytes.length) {
    const afterLt = bytes[lt + 1];

    // Comment: <!-- ... --> or <!--> (empty comment)
    if (afterLt === 0x21 && lt + 4 <= bytes.length &&
        bytes[lt + 2] === 0x2d && bytes[lt + 3] === 0x2d) { // !--
      // Check for <!--> (empty comment)
      if (lt + 5 <= bytes.length && bytes[lt + 4] === 0x3e) {
        return { tagName: null, start: lt, end: lt + 5, selfClosing: false,
          raw: "<!-->", attrs: new Map(), comment: true };
      }
      // Find -->
      const commentEnd = indexOfStr(bytes, "-->", lt + 4);
      if (commentEnd !== -1) {
        const raw = bytes.subarray(lt, commentEnd + 3).toString("utf-8");
        return { tagName: null, start: lt, end: commentEnd + 3, selfClosing: false,
          raw, attrs: new Map(), comment: true };
      }
      // Unclosed comment: runs to end of input
      const raw = bytes.subarray(lt).toString("utf-8");
      return { tagName: null, start: lt, end: bytes.length, selfClosing: false,
        raw, attrs: new Map(), comment: true, unclosed: true };
    }

    // <!> (empty comment per spec)
    if (afterLt === 0x21 && lt + 2 < bytes.length && bytes[lt + 2] === 0x3e) {
      return { tagName: null, start: lt, end: lt + 3, selfClosing: false,
        raw: "<!>", attrs: new Map(), comment: true };
    }

    // DOCTYPE or other <!...>
    if (afterLt === 0x21 || afterLt === 0x3f) { // ! or ?
      const gt = indexOfStr(bytes, ">", lt + 2);
      if (gt === -1) {
        const raw = bytes.subarray(lt).toString("utf-8");
        return { tagName: null, start: lt, end: bytes.length, selfClosing: false,
          raw, attrs: new Map(), comment: true, unclosed: true };
      }
      const raw = bytes.subarray(lt, gt + 1).toString("utf-8");
      return { tagName: null, start: lt, end: gt + 1, selfClosing: false,
        raw, attrs: new Map(), comment: true };
    }
  }

  // Regular tag: find '>' outside quotes
  const gt = findGtOutsideQuotes(bytes, lt + 1);
  if (gt === -1) return null;

  const raw = bytes.subarray(lt, gt + 1).toString("utf-8");
  const inner = raw.slice(1, -1).trim();

  // Check for closing tag </name>
  // Keep '/' prefix for closing tags to maintain compatibility
  let tagName = null;
  if (inner.startsWith("/")) {
    const afterSlash = inner.slice(1).trim();
    const spaceIdx = afterSlash.search(/\s/);
    const name = (spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx)).toLowerCase();
    tagName = "/" + name;
  } else {
    const spaceIdx = inner.search(/\s/);
    if (spaceIdx === -1) {
      tagName = inner.replace(/\/$/, "").toLowerCase();
    } else {
      tagName = inner.slice(0, spaceIdx).toLowerCase();
    }
  }

  const attrs = parseAttrs(inner);

  const selfClosing = raw.endsWith("/>") || ["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"].includes(tagName);

  return {
    tagName,
    start: lt,
    end: gt + 1,
    selfClosing,
    raw,
    attrs,
    comment: false,
  };
}

/**
 * Extract an attribute value from a tag's parsed attributes Map.
 * Exact lowercased key match only.
 */
function attrValue(attrs, attrName) {
  return attrs.get(attrName.toLowerCase()) ?? null;
}

/**
 * Find closing tag case-insensitively at byte level.
 * Handles </TAGNAME>, </tagname>, </Tagname>, etc.
 * Returns byte position AFTER the closing tag, or -1 if not found.
 */
function findCloseTagCi(bytes, tagName, startPos, missCache) {
  const lowerTag = tagName.toLowerCase();
  const bufLen = bytes.length;

  // Memoised miss: if we already know this tag has no close from >= startPos, skip
  if (missCache) {
    const missFrom = missCache.get(lowerTag);
    if (missFrom !== undefined && startPos >= missFrom) {
      return -1;
    }
  }

  for (let i = startPos; i <= bufLen - 3; i++) {
    if (bytes[i] !== 0x3c) continue; // <
    const next = bytes[i + 1];
    if (next !== 0x2f && next !== 0x2F) continue; // /

    // Try to match the tag name case-insensitively
    const tagStart = i + 2;
    if (tagStart + lowerTag.length > bufLen) continue;

    let matched = true;
    for (let j = 0; j < lowerTag.length; j++) {
      const c = bytes[tagStart + j];
      const expected = lowerTag.charCodeAt(j);
      // Case-insensitive ASCII match
      if ((c | 0x20) !== (expected | 0x20)) { matched = false; break; }
    }
    if (!matched) continue;

    // Check for > after tag name (optionally with whitespace)
    let after = tagStart + lowerTag.length;
    while (after < bufLen && (bytes[after] === 0x20 || bytes[after] === 0x09 || bytes[after] === 0x0a || bytes[after] === 0x0d)) {
      after++;
    }
    if (after < bufLen && bytes[after] === 0x3e) {
      return after + 1; // past the >
    }
  }

  // Record miss: any search from >= startPos for this tag will also miss
  if (missCache) {
    const prev = missCache.get(lowerTag);
    if (prev === undefined || startPos < prev) {
      missCache.set(lowerTag, startPos);
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Entity decoding — single left-to-right pass
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = Object.assign(Object.create(null), {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0",
  iexcl: "\u00A1", cent: "\u00A2", pound: "\u00A3", curren: "\u00A4",
  yen: "\u00A5", brvbar: "\u00A6", sect: "\u00A7", uml: "\u00A8",
  copy: "\u00A9", ordf: "\u00AA", laquo: "\u00AB", not: "\u00AC",
  shy: "\u00AD", reg: "\u00AE", macr: "\u00AF", deg: "\u00B0",
  plusmn: "\u00B1", sup2: "\u00B2", sup3: "\u00B3", acute: "\u00B4",
  micro: "\u00B5", para: "\u00B6", middot: "\u00B7", cedil: "\u00B8",
  sup1: "\u00B9", ordm: "\u00BA", raquo: "\u00BB", frac14: "\u00BC",
  frac12: "\u00BD", frac34: "\u00BE", iquest: "\u00BF",
  times: "\u00D7", divide: "\u00F7",
  Agrave: "\u00C0", Aacute: "\u00C1", Acirc: "\u00C2", Atilde: "\u00C3",
  Auml: "\u00C4", Aring: "\u00C5", AElig: "\u00C6", Ccedil: "\u00C7",
  Egrave: "\u00C8", Eacute: "\u00C9", Ecirc: "\u00CA", Euml: "\u00CB",
  Igrave: "\u00CC", Iacute: "\u00CD", Icirc: "\u00CE", Iuml: "\u00CF",
  ETH: "\u00D0", Ntilde: "\u00D1", Ograve: "\u00D2", Oacute: "\u00D3",
  Ocirc: "\u00D4", Otilde: "\u00D5", Ouml: "\u00D6", Oslash: "\u00D8",
  Ugrave: "\u00D9", Uacute: "\u00DA", Ucirc: "\u00DB", Uuml: "\u00DC",
  Yacute: "\u00DD", THORN: "\u00DE", szlig: "\u00DF",
  agrave: "\u00E0", aacute: "\u00E1", acirc: "\u00E2", atilde: "\u00E3",
  auml: "\u00E4", aring: "\u00E5", aelig: "\u00E6", ccedil: "\u00E7",
  egrave: "\u00E8", eacute: "\u00E9", ecirc: "\u00EA", euml: "\u00EB",
  igrave: "\u00EC", iacute: "\u00ED", icirc: "\u00EE", iuml: "\u00EF",
  eth: "\u00F0", ntilde: "\u00F1", ograve: "\u00F2", oacute: "\u00F3",
  ocirc: "\u00F4", otilde: "\u00F5", ouml: "\u00F6", oslash: "\u00F8",
  ugrave: "\u00F9", uacute: "\u00FA", ucirc: "\u00FB", uuml: "\u00FC",
  yacute: "\u00FD", thorn: "\u00FE", yuml: "\u00FF",
  OElig: "\u0152", oelig: "\u0153", Scaron: "\u0160", scaron: "\u0161",
  Yuml: "\u0178", fnof: "\u0192", circ: "\u02C6", tilde: "\u02DC",
  Alpha: "\u0391", Beta: "\u0392", Gamma: "\u0393", Delta: "\u0394",
  Epsilon: "\u0395", Zeta: "\u0396", Eta: "\u0397", Theta: "\u0398",
  Iota: "\u0399", Kappa: "\u039A", Lambda: "\u039B", Mu: "\u039C",
  Nu: "\u039D", Xi: "\u039E", Omicron: "\u039F", Pi: "\u03A0",
  Rho: "\u03A1", Sigma: "\u03A3", Tau: "\u03A4", Upsilon: "\u03A5",
  Phi: "\u03A6", Chi: "\u03A7", Psi: "\u03A8", Omega: "\u03A9",
  alpha: "\u03B1", beta: "\u03B2", gamma: "\u03B3", delta: "\u03B4",
  epsilon: "\u03B5", zeta: "\u03B6", eta: "\u03B7", theta: "\u03B8",
  iota: "\u03B9", kappa: "\u03BA", lambda: "\u03BB", mu: "\u03BC",
  nu: "\u03BD", xi: "\u03BE", omicron: "\u03BF", pi: "\u03C0",
  rho: "\u03C1", sigmaf: "\u03C2", sigma: "\u03C3", tau: "\u03C4",
  upsilon: "\u03C5", phi: "\u03C6", chi: "\u03C7", psi: "\u03C8",
  omega: "\u03C9", thetasym: "\u03D1", upsih: "\u03D2", piv: "\u03D6",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200C",
  zwj: "\u200D", lrm: "\u200E", rlm: "\u200F", ndash: "\u2013",
  mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201A",
  ldquo: "\u201C", rdquo: "\u201D", bdquo: "\u201E", dagger: "\u2020",
  Dagger: "\u2021", bull: "\u2022", hellip: "\u2026", permil: "\u2030",
  prime: "\u2032", Prime: "\u2033", lsaquo: "\u2039", rsaquo: "\u203A",
  oline: "\u203E", frasl: "\u2044", euro: "\u20AC", image: "\u2111",
  weierp: "\u2118", real: "\u211C", trade: "\u2122", alefsym: "\u2135",
  larr: "\u2190", uarr: "\u2191", rarr: "\u2192", darr: "\u2193",
  harr: "\u2194", crarr: "\u21B5", lArr: "\u21D0", uArr: "\u21D1",
  rArr: "\u21D2", dArr: "\u21D3", hArr: "\u21D4", forall: "\u2200",
  part: "\u2202", exist: "\u2203", empty: "\u2205", nabla: "\u2207",
  isin: "\u2208", notin: "\u2209", ni: "\u220B", prod: "\u220F",
  sum: "\u2211", minus: "\u2212", lowast: "\u2217", radic: "\u221A",
  prop: "\u221D", infin: "\u221E", ang: "\u2220", and: "\u2227",
  or: "\u2228", cap: "\u2229", cup: "\u222A", int: "\u222B",
  there4: "\u2234", sim: "\u223C", cong: "\u2245", asymp: "\u2248",
  ne: "\u2260", equiv: "\u2261", le: "\u2264", ge: "\u2265",
  sub: "\u2282", sup: "\u2283", nsub: "\u2284", sube: "\u2286",
  supe: "\u2287", oplus: "\u2295", otimes: "\u2297", perp: "\u22A5",
  sdot: "\u22C5", lceil: "\u2308", rceil: "\u2309", lfloor: "\u230A",
  rfloor: "\u230B", lang: "\u2329", rang: "\u232A", loz: "\u25CA",
  spades: "\u2660", clubs: "\u2663", hearts: "\u2665", diams: "\u2666",
});

/**
 * Decode HTML entities in a single left-to-right pass.
 * - Named entities: decode if known, stay literal if unknown.
 * - Numeric entities: decode if valid (1..0x10FFFF, non-surrogate), else U+FFFD.
 * - Never throws. One pass only (no double-decoding).
 */
function decodeEntities(str) {
  let out = '';
  let i = 0;
  const len = str.length;

  while (i < len) {
    if (str[i] === '&') {
      // Look for ';'
      let semiIdx = -1;
      for (let j = i + 1; j < len && j < i + 32; j++) {
        if (str[j] === ';') { semiIdx = j; break; }
      }

      if (semiIdx === -1) {
        // No semicolon: not an entity, emit & and continue
        out += '&';
        i++;
        continue;
      }

      const entity = str.slice(i + 1, semiIdx);

      if (entity.length === 0) {
        out += '&;';
        i = semiIdx + 1;
        continue;
      }

      // Numeric entity
      if (entity[0] === '#') {
        const rest = entity.slice(1);
        let codepoint;
        if (rest.length > 0 && (rest[0] === 'x' || rest[0] === 'X')) {
          codepoint = parseInt(rest.slice(1), 16);
        } else {
          codepoint = parseInt(rest, 10);
        }

        if (Number.isNaN(codepoint) || codepoint < 1 || codepoint > 0x10FFFF ||
            (codepoint >= 0xD800 && codepoint <= 0xDFFF)) {
          out += '\uFFFD';
        } else {
          out += String.fromCodePoint(codepoint);
        }
        i = semiIdx + 1;
        continue;
      }

      // Named entity
      const lowerEntity = entity.toLowerCase();
      const decoded = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[lowerEntity];
      if (decoded !== undefined) {
        out += decoded;
      } else {
        // Unknown named entity: stay literal
        out += '&' + entity + ';';
      }
      i = semiIdx + 1;
      continue;
    }

    out += str[i];
    i++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Element categories per HTML spec
// ---------------------------------------------------------------------------

const RAW_TEXT_ELEMENTS = new Set([
  "script", "style", "xmp", "iframe", "noembed", "noframes",
]);

const RCDATA_ELEMENTS = new Set([
  "title", "textarea",
]);

// ---------------------------------------------------------------------------
// Text extraction between two byte positions
// ---------------------------------------------------------------------------

function textBetween(bytes, start, end) {
  // Walk bytes directly with one forward cursor p from start to end.
  // On 0x3C ('<'): skip the tag (findGtOutsideQuotes bounded by end).
  // Each text run between tags is decoded ONCE via bytes.toString('utf-8', runStart, runEnd).
  // 0x3C never occurs inside a UTF-8 multi-byte sequence, so scanning bytes is safe.
  let content = "";
  let lastWasSpace = false;
  let p = start;

  while (p < end) {
    const b = bytes[p];
    if (b === 0x3C) { // '<' - start of a tag
      const gt = findGtOutsideQuotes(bytes, p + 1, end);
      if (gt === -1) break; // unclosed tag: drop rest of span
      p = gt + 1; // skip past '>'
      continue;
    }
    // Text byte — accumulate until next '<' or end
    const runStart = p;
    while (p < end && bytes[p] !== 0x3C) p++;
    // Decode this text run once
    const runStr = bytes.toString('utf-8', runStart, p);
    for (let i = 0; i < runStr.length; i++) {
      const ch = runStr[i];
      if (WS_RE.test(ch)) {
        if (!lastWasSpace && content.length > 0) {
          content += " ";
          lastWasSpace = true;
        }
        continue;
      }
      content += ch;
      lastWasSpace = false;
    }
  }

  return decodeEntities(content.trim());
}
// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * extractFromHtml(bytes: Buffer) → extracted page facts with byte-level evidence.
 *
 * Never throws on any input. Returns an object with:
 *   title, description, canonical, headings[], links[], jsonLd[]
 */
export function extractFromHtml(bytes) {
  try {
    return extractFromHtmlImpl(bytes);
  } catch {
    return emptyResult();
  }
}

function extractFromHtmlImpl(bytes) {
  const missCache = new Map();
  const result = {
    title: null,
    description: null,
    canonical: null,
    headings: [],
    links: [],
    jsonLd: [],
  };

  let headTitle = null;
  let fallbackTitle = null;
  let inHead = false;
  let inSvg = false;
  let inMath = false;
  let pos = 0;

  while (pos < bytes.length) {
    const tag = nextTag(bytes, pos);
    if (!tag) break;

    // Skip comments
    if (tag.comment) {
      pos = tag.end;
      continue;
    }

    const tagName = tag.tagName;
    if (!tagName) { pos = tag.end; continue; }

    // Track head / svg / math context
    if (tagName === "head") { inHead = true; pos = tag.end; continue; }
    if (tagName === "/head") { inHead = false; pos = tag.end; continue; }
    if (tagName === "svg") { inSvg = true; pos = tag.end; continue; }
    if (tagName === "/svg") { inSvg = false; pos = tag.end; continue; }
    if (tagName === "math") { inMath = true; pos = tag.end; continue; }
    if (tagName === "/math") { inMath = false; pos = tag.end; continue; }

    // --- Structural skip for raw-text and RCDATA elements ---
    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const closeIdx = findCloseTagCi(bytes, tagName, tag.end, missCache);

      if (tagName === "script") {
        const typeAttr = attrValue(tag.attrs, "type");
        if (typeAttr === "application/ld+json") {
          // JSON-LD script: extract content between tags
          let contentEnd = closeIdx;
          if (contentEnd === -1) {
            contentEnd = bytes.length;
          } else {
            for (let ci = contentEnd - 1; ci >= tag.end; ci--) {
              if (bytes[ci] === 0x3c) { contentEnd = ci; break; }
            }
          }
          const jsonText = bytes.toString("utf-8", tag.end, contentEnd).trim();
          const evidenceEnd = closeIdx === -1 ? bytes.length : closeIdx;
          const evidence = { start: tag.start, end: evidenceEnd };
          let data = null;
          let verified = false;
          try {
            data = JSON.parse(jsonText);
            verified = true;
          } catch {
            // unparseable: store as unverified
          }
          result.jsonLd.push({
            data,
            raw: jsonText,
            verified,
            evidence,
          });
        }
      }

      if (closeIdx !== -1) {
        pos = closeIdx;
      } else {
        pos = bytes.length;
      }
      continue;
    }

    if (RCDATA_ELEMENTS.has(tagName)) {
      const closeIdx = findCloseTagCi(bytes, tagName, tag.end, missCache);
      let contentEnd = closeIdx;
      if (contentEnd === -1) {
        contentEnd = bytes.length;
      } else {
        for (let ci = contentEnd - 1; ci >= tag.end; ci--) {
          if (bytes[ci] === 0x3c) { contentEnd = ci; break; }
        }
      }

      if (tagName === "title") {
        if (!inSvg && !inMath) {
          const rawTitleBytes = bytes.subarray(tag.end, contentEnd);
          const titleText = decodeEntities(rawTitleBytes.toString("utf-8").trim());
          if (inHead) {
            headTitle = titleText;
          } else if (fallbackTitle === null) {
            fallbackTitle = titleText;
          }
        }
      }

      if (closeIdx !== -1) {
        pos = closeIdx;
      } else {
        pos = bytes.length;
      }
      continue;
    }
    // --- End structural skip ---

    if (tagName === "meta") {
      const name = attrValue(tag.attrs, "name") || attrValue(tag.attrs, "property");
      const content = attrValue(tag.attrs, "content");
      if (name === "description" && content) {
        result.description = decodeEntities(content);
      }
      pos = tag.end;
      continue;
    }

    if (tagName === "link") {
      const rel = attrValue(tag.attrs, "rel");
      if (rel === "canonical") {
        const href = attrValue(tag.attrs, "href");
        if (href) result.canonical = href;
      }
      pos = tag.end;
      continue;
    }

    if (/^h[1-6]$/.test(tagName)) {
      const level = parseInt(tagName[1], 10);
      const closeEnd = findCloseTagCi(bytes, tagName, tag.end, missCache);
      if (closeEnd !== -1) {
        let contentEnd = closeEnd;
        for (let ci = closeEnd - 1; ci >= tag.end; ci--) {
          if (bytes[ci] === 0x3c) { contentEnd = ci; break; }
        }
        const headingText = textBetween(bytes, tag.end, contentEnd);
        result.headings.push({
          level,
          text: headingText,
          evidence: { start: tag.start, end: closeEnd },
        });
        pos = closeEnd;
      } else {
        pos = tag.end;
      }
      continue;
    }

    if (tagName === "a") {
      const href = attrValue(tag.attrs, "href");
      const rel = attrValue(tag.attrs, "rel");
      if (!href) {
        pos = tag.end;
        continue;
      }
      const closeEnd = findCloseTagCi(bytes, "a", tag.end, missCache);
      if (closeEnd === -1) {
        pos = tag.end;
        continue;
      }
      let contentEnd = closeEnd;
      for (let ci = closeEnd - 1; ci >= tag.end; ci--) {
        if (bytes[ci] === 0x3c) { contentEnd = ci; break; }
      }
      const linkText = textBetween(bytes, tag.end, contentEnd);
      result.links.push({
        href,
        rel,
        text: linkText,
        evidence: { start: tag.start, end: closeEnd },
      });
      pos = closeEnd;
      continue;
    }

    pos = tag.end;
  }

  result.title = headTitle ?? fallbackTitle;
  return result;
}

function emptyResult() {
  return {
    title: null,
    description: null,
    canonical: null,
    headings: [],
    links: [],
    jsonLd: [],
  };
}
