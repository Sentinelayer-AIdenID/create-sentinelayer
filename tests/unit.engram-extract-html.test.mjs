import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { extractFromHtml } from "../src/engram/extract-html.js";

// =============================================================================
// Finding 4: byte offsets must be valid UTF-8 byte positions
// =============================================================================

test("Finding 4: evidence spans slice to exact element bytes with multibyte text", async () => {
  const html = '<html><head><title>Test</title></head><body>\n<h1>Caf\u00e9 \u{1F375}</h1>\n<script type="application/ld+json">{"name":"caf\u00e9"}</script>\n</body></html>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);

  assert.ok(result.headings.length >= 1, "should find at least one heading");
  const h1 = result.headings.find(h => h.level === 1);
  assert.ok(h1, "should find h1");
  assert.equal(h1.text, "Caf\u00e9 \u{1F375}", "heading text should include multibyte characters");
  
  const evidenceSlice = bytes.subarray(h1.evidence.start, h1.evidence.end).toString("utf-8");
  assert.ok(evidenceSlice.includes("Caf\u00e9"), `evidence slice should contain the heading text, got: ${evidenceSlice}`);
  assert.ok(evidenceSlice.startsWith("<h1>"), `evidence should start with <h1>, got: ${evidenceSlice.substring(0, 10)}`);
  assert.ok(evidenceSlice.endsWith("</h1>"), `evidence should end with </h1>, got: ${evidenceSlice.slice(-10)}`);

  assert.ok(result.jsonLd.length >= 1, "should find JSON-LD");
  const jsonld = result.jsonLd[0];
  assert.equal(jsonld.verified, true);
  const ldSlice = bytes.subarray(jsonld.evidence.start, jsonld.evidence.end).toString("utf-8");
  assert.ok(ldSlice.includes('"name":"caf\u00e9"'), `JSON-LD slice should contain the name, got: ${ldSlice}`);
  assert.ok(ldSlice.startsWith('<script'), `JSON-LD evidence should start with <script, got: ${ldSlice.substring(0, 15)}`);
});

test("Finding 4: multibyte text before tag does not corrupt offsets", async () => {
  const html = '\u00e9<h1>Hello</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  
  assert.ok(result.headings.length >= 1);
  const h1 = result.headings[0];
  assert.equal(h1.text, "Hello");
  
  const evidenceSlice = bytes.subarray(h1.evidence.start, h1.evidence.end).toString("utf-8");
  assert.equal(evidenceSlice, "<h1>Hello</h1>");
});

// =============================================================================
// Finding 5: JSON-LD in HTML comments, script/style content skipped
// =============================================================================

test("Finding 5: JSON-LD in HTML comment is NOT extracted", async () => {
  const html = '<!-- <script type="application/ld+json">{"name":"comment-only"}</script> -->';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 0, "JSON-LD inside HTML comment must not be extracted");
});

test("Finding 5: script element with non-JSON-LD content does not produce headings", async () => {
  const html = '<script>const example="<h1>script-only</h1>";</script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 0, "headings inside non-JSON-LD script element must not be extracted");
});

test("Finding 5: real heading next to script comment is still found", async () => {
  const html = '<script>const example="<h1>script-only</h1>";</script><h1>Real Heading</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "real heading outside script must still be found");
  assert.equal(result.headings[0].text, "Real Heading");
});

test("Finding 5: style element content is skipped", async () => {
  const html = '<style>.my-class { color: red; }</style><h1>Visible</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "Visible");
});

// =============================================================================
// Finding 6: entity decoding
// =============================================================================

test("Finding 6: named entities are decoded, not stripped", async () => {
  const html = '<h1>AT&amp;T: 5 &lt; 10 &#38; more</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "AT&T: 5 < 10 & more", 
    "named entities must be decoded, not stripped");
});

test("Finding 6: hex entities are decoded", async () => {
  const html = '<h1>&#x26; hex ampersand &#x3C; hex lt</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "& hex ampersand < hex lt",
    "hex entities must be decoded");
});

test("Finding 6: entities in title are decoded", async () => {
  const html = '<html><head><title>Foo &amp; Bar &lt; Baz</title></head><body></body></html>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.title, "Foo & Bar < Baz");
});

test("Finding 6: entities in link text are decoded", async () => {
  const html = '<a href="/test">Click &amp; Go &gt;</a>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].text, "Click & Go >");
});

// =============================================================================
// Finding 8: case-insensitive tag matching
// =============================================================================

test("Finding 8: uppercase </SCRIPT> closing tag yields JSON-LD", async () => {
  const html = '<script type="application/ld+json">{"a":1}</SCRIPT>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 1, "JSON-LD must be found with uppercase closing tag");
  assert.equal(result.jsonLd[0].verified, true);
  assert.deepStrictEqual(result.jsonLd[0].data, { a: 1 });

  const evidenceSlice = bytes.subarray(result.jsonLd[0].evidence.start, result.jsonLd[0].evidence.end).toString("utf-8");
  assert.ok(evidenceSlice.startsWith('<script'), `evidence should start with <script, got: ${evidenceSlice.substring(0, 15)}`);
  assert.ok(evidenceSlice.endsWith('</SCRIPT>'), `evidence should end with </SCRIPT>, got: ${evidenceSlice.slice(-15)}`);
});

test("Finding 8: mixed-case </Script> closing tag yields JSON-LD", async () => {
  const html = '<script type="application/ld+json">{"b":2}</Script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 1, "JSON-LD must be found with mixed-case closing tag");
  assert.equal(result.jsonLd[0].verified, true);
  assert.deepStrictEqual(result.jsonLd[0].data, { b: 2 });

  const evidenceSlice = bytes.subarray(result.jsonLd[0].evidence.start, result.jsonLd[0].evidence.end).toString("utf-8");
  assert.ok(evidenceSlice.endsWith('</Script>'), `evidence should end with </Script>, got: ${evidenceSlice.slice(-15)}`);
});

test("Finding 8: lowercase </script> still works", async () => {
  const html = '<script type="application/ld+json">{"c":3}</script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 1);
  assert.equal(result.jsonLd[0].verified, true);
  assert.deepStrictEqual(result.jsonLd[0].data, { c: 3 });
});

test("Finding 8: non-JSON-LD script with uppercase close is skipped", async () => {
  const html = '<script>var x = 1;</SCRIPT><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "heading outside script must be found");
  assert.equal(result.headings[0].text, "Real");
  assert.equal(result.jsonLd.length, 0, "non-JSON-LD script must not produce JSON-LD");
});

// =============================================================================
// R7-3: uppercase OPENING tags
// =============================================================================

test("R7-3: uppercase <SCRIPT> opening tag with JSON-LD yields item", async () => {
  const html = '<SCRIPT type="application/ld+json">{"b":2}</Script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 1, "JSON-LD must be found with uppercase opening tag");
  assert.equal(result.jsonLd[0].verified, true);
  assert.deepStrictEqual(result.jsonLd[0].data, { b: 2 });
  const evidenceSlice = bytes.subarray(result.jsonLd[0].evidence.start, result.jsonLd[0].evidence.end).toString("utf-8");
  assert.ok(evidenceSlice.startsWith('<SCRIPT'), `evidence should start with <SCRIPT, got: ${evidenceSlice.substring(0, 15)}`);
});

test("R7-3: uppercase <STYLE> opening tag with mixed close skips content", async () => {
  const html = '<STYLE>.x{color:red}</Style><h1>Hi</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "heading outside STYLE must be found");
  assert.equal(result.headings[0].text, "Hi");
});

test("R7-3: uppercase <SCRIPT> opening tag with uppercase close</SCRIPT> yields JSON-LD", async () => {
  const html = '<SCRIPT type="application/ld+json">{"a":1}</SCRIPT>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 1, "JSON-LD must be found with all-uppercase tags");
  assert.equal(result.jsonLd[0].verified, true);
  assert.deepStrictEqual(result.jsonLd[0].data, { a: 1 });
});

test("R8-1: textarea content is RCDATA — headings inside <textarea> must not be extracted", async () => {
  const html = '<textarea><h1>text</h1></textarea><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "only one heading outside textarea");
  assert.equal(result.headings[0].text, "Real");
});

test("R8-1: title content is RCDATA — headings inside <title> must not be extracted", async () => {
  const html = '<html><head><title>a<h1>t</h1></title></head><body></body></html>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 0, "no headings from title RCDATA content");
});

test("R8-1: codex-second matrix — textarea, script, style, comment all skipped; only Real heading kept", async () => {
  const html = '<!-- <i>x</i><h1>comment</h1><script type="application/ld+json">{"inactive":true}</script> --><script>const x="<h1>script</h1>";</script><style>.x{content:"<h1>style</h1>"}</style><textarea><h1>text</h1></textarea><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "only one real heading outside all raw text elements");
  assert.equal(result.headings[0].text, "Real");
  assert.equal(result.jsonLd.length, 0, "no JSON-LD — the only script is inside an HTML comment");
});

test("R8-1: title text still extracted as document title but headings inside it are skipped", async () => {
  const html = '<html><head><title>a<h1>t</h1></title></head><body><h1>Body</h1></body></html>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.title, "a<h1>t</h1>", "title text is the raw RCDATA content");
  assert.equal(result.headings.length, 1, "only body heading");
  assert.equal(result.headings[0].text, "Body");
});

test("R8-1: JSON-LD string with comment-lookalike literal still parses", async () => {
  const html = '<script type="application/ld+json">{"name":"<!-- literal -->"}</script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 1);
  assert.equal(result.jsonLd[0].verified, true);
  assert.deepEqual(result.jsonLd[0].data, { name: "<!-- literal -->" });
});

// =============================================================================
// R9-1: structural skip for raw-text and RCDATA elements
// =============================================================================

test("R9-1: script with textarea string inside does not hide later content", async () => {
  const html = '<script>var a="<textarea>";</script><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "should find heading after script with textarea string");
  assert.equal(result.headings[0].text, "Real");
});

test("R9-1: textarea with style tag inside does not hide later content", async () => {
  const html = '<textarea><style></textarea><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "should find heading after textarea with style tag inside");
  assert.equal(result.headings[0].text, "Real");
});

test("R9-1: style with script comment inside does not hide later content", async () => {
  const html = '<style>/* <script> */</style><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "should find heading after style with script comment");
  assert.equal(result.headings[0].text, "Real");
});

test("R9-1: xmp consumes content to close tag, later heading is found", async () => {
  const html = '<xmp><h1>x</h1></xmp><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "xmp content must be skipped, only Real heading");
  assert.equal(result.headings[0].text, "Real");
});

test("R9-1: iframe consumes content to close tag", async () => {
  const html = '<iframe><h1>x</h1></iframe><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "iframe content must be skipped");
  assert.equal(result.headings[0].text, "Real");
});

test("R9-1: noembed consumes content to close tag", async () => {
  const html = '<noembed><h1>x</h1></noembed><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "noembed content must be skipped");
  assert.equal(result.headings[0].text, "Real");
});

test("R9-1: noframes consumes content to close tag", async () => {
  const html = '<noframes><h1>x</h1></noframes><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "noframes content must be skipped");
  assert.equal(result.headings[0].text, "Real");
});

test("R9-1: style with raw text + real heading; evidence spans are correct", async () => {
  const html = '<style>/* <script> */</style><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "Real");
  const evidenceSlice = bytes.subarray(result.headings[0].evidence.start, result.headings[0].evidence.end).toString("utf-8");
  assert.equal(evidenceSlice, "<h1>Real</h1>", "evidence slice must be exact");
});

test("R9-1: unclosed raw element consumes to end of input", async () => {
  const html = '<script>var a="<h1>never</h1>"';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 0, "unclosed script must consume everything");
  assert.equal(result.jsonLd.length, 0, "no JSON-LD from unclosed script");
});

// =============================================================================
// R13: extractor tokenizer fixes
// =============================================================================

// R13-1: Tag scanning — > inside attribute value does not end the tag
test("R13-1: > inside attribute value does not end the tag", async () => {
  const html = '<a title="x><h1>fake</h1>">link</a><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "only one real heading outside attribute value");
  assert.equal(result.headings[0].text, "Real", "the h1 inside attribute value must not be extracted");
});

// R13-2: Attribute lookup — data-type does not match type
test("R13-2: data-type attribute does not match type for JSON-LD", async () => {
  const html = '<script data-type="application/ld+json">{"fake":true}</script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 0, "data-type must not match type; no JSON-LD extracted");
});

// R13-3: Comments — unclosed comment runs to end of input
test("R13-3a: unclosed comment consumes everything to end of input", async () => {
  const html = '<!-- open > <h1>hidden</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 0, "unclosed comment must consume everything");
});

test("R13-3b: <!> is an empty comment", async () => {
  const html = '<!><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "heading after <!> empty comment must be found");
  assert.equal(result.headings[0].text, "Real");
});

test("R13-3c: <!--> is an empty comment", async () => {
  const html = '<!--><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1, "heading after <!--> empty comment must be found");
  assert.equal(result.headings[0].text, "Real");
});

// R13-4: Entities — single-pass decode, no double-decode
test("R13-4a: entities decoded once, not double-decoded", async () => {
  const html = '<h1>a &amp;lt; b</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "a &lt; b", "entities decoded exactly once: &amp; -> &, &lt; stays literal");
});

test("R13-4b: out-of-range numeric entity becomes U+FFFD, never throws", async () => {
  const html = '<h1>x &#1114112; y</h1><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 2, "both headings must be found even with out-of-range entity");
  assert.equal(result.headings[0].text, "x \uFFFD y", "out-of-range entity becomes U+FFFD");
  assert.equal(result.headings[1].text, "Real");
});

test("R13-4c: surrogate numeric entity becomes U+FFFD", async () => {
  const html = '<h1>&#xD800;</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "\uFFFD", "surrogate entity becomes U+FFFD");
});

test("R13-4d: entity zero becomes U+FFFD", async () => {
  const html = '<h1>&#0;</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "\uFFFD", "entity 0 becomes U+FFFD");
});

test("R13-4e: unknown named entity stays literal", async () => {
  const html = '<h1>&unknown;</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "&unknown;", "unknown named entity stays literal");
});

// R13-5: Robustness — random fragments never throw, spans slice back
test("R13-5: random/malformed fragments never throw and spans slice back", async () => {
  // Deterministic seeded fragments
  const fragments = [
    // Malformed tags
    '<a<b>text</b>',
    '<>text</>',
    '<<<h1>nested</h1>>>>',
    '</h1>orphan closing</h1>',
    '<h1 attr=unquoted>unquoted attr</h1>',
    "<h1 attr='single'>single</h1>",
    '<h1 attr="double">double</h1>',
    '<h1 attr=unquoted value>multiple</h1>',
    '<h1 =value>nameless</h1>',
    '<h1 attr=>empty value</h1>',
    '<h1 "attr"="value">quoted attr name</h1>',
    // Nested/broken comments
    '<!-- comment --><h1>after comment</h1>',
    '<!-- nested <!-- inner --> outer --><h1>Real</h1>',
    '<!-- -- > still comment --><h1>Real</h1>',
    '<!-- -> not end --><h1>Real</h1>',
    '<!-->empty comment<//h1>Real</h1>',
    // Broken entities
    '<h1>orphan & </h1>',
    '<h1>&amp</h1>',
    '<h1>&#;</h1>',
    '<h1>&#x;</h1>',
    '<h1>&#999999999999;</h1>',
    '<h1>&#xFFFFFFFFF;</h1>',
    '<h1>&#-1;</h1>',
    '<h1>&#x-1;</h1>',
    '<h1>&&amp;;</h1>',
    '<h1>&#xG;</h1>',
    // Mixed case tags
    '<H1>upper</H1>',
    '<h1>lower</h1>',
    '<H1>Upper Tag</H1><h2>lower</h2>',
    // Raw text elements
    '<script>var x="<h1>skip</h1>";</script><h1>Real</h1>',
    '<style>.h1 { color: red; }</style><h1>Real</h1>',
    '<title><h1>skip in title</h1></title><h1>Real</h1>',
    '<textarea><h1>skip in textarea</h1></textarea><h1>Real</h1>',
    '<xmp><h1>xmp content</h1></xmp><h1>Real</h1>',
    '<iframe><h1>iframe content</h1></iframe><h1>Real</h1>',
    '<noembed><h1>noembed content</h1></noembed><h1>Real</h1>',
    '<noframes><h1>skip</h1></noframes><h1>Real</h1>',
    // Unclosed raw text
    '<script>unclosed script',
    '<style>unclosed style',
    '<textarea>unclosed textarea',
    '<title>unclosed title',
    '<xmp>unclosed xmp',
    '<iframe>unclosed iframe',
    '<noembed>unclosed noembed',
    '<noframes>unclosed noframes',
    // Void/self-closing
    '<br>',
    '<br/>',
    '<hr>',
    '<hr/>',
    '<img src="x.jpg">',
    '<img src="x.jpg"/>',
    '<input type="text">',
    '<input type="text"/>',
    '<meta charset="utf-8">',
    '<meta charset="utf-8"/>',
    '<link rel="stylesheet" href="x.css">',
    '<link rel="stylesheet" href="x.css"/>',
    // DOCTYPE
    '<!DOCTYPE html><h1>Real</h1>',
    '<!doctype html><h1>Real</h1>',
    // CDATA-like (not real CDATA in HTML, but common)
    '<![CDATA[<h1>cdata</h1>]]><h1>Real</h1>',
    // Multibyte
    'Caf\u00e9<h1>\u00e9\u{1F375}\u00e9</h1>',
    '\u00e9<h1>\u{1F600}</h1>',
    // Deeply nested
    '<div><div><div><div><h1>deep</h1></div></div></div></div>',
    // Links with nested elements
    '<a href="/x"><span>click</span> here</a>',
    // JSON-LD variants
    '<script type="application/ld+json">{"@context":"http://schema.org","@type":"WebPage"}</script>',
    '<script TYPE="application/ld+json">{"name":"mixed"}</script>',
    '<script type="application/ld+json">{broken json}</script>',
    // Meta variants
    '<meta name="description" content="My desc">',
    '<meta property="og:title" content="OG Title">',
    // Link canonical
    '<link rel="canonical" href="https://example.com">',
    // Empty input
    '',
    // Only text
    'Just some text without tags',
    // Whitespace only
    '   \n\t  ',
    // Partial tag at end
    '<h1>Real</h1><incomplete',
    // Angle brackets in text
    '<h1>a < b > c</h1>',
    // Multiple JSON-LD
    '<script type="application/ld+json">{"a":1}</script><script type="application/ld+json">{"b":2}</script>',
    // Script with type not ld+json
    '<script type="text/javascript">var x=1;</script><h1>Real</h1>',
    // SVG elements (skip)
    '<svg><h1>svg heading</h1></svg><h1>Real</h1>',
    // Math elements (skip)
    '<math><h1>math heading</h1></math><h1>Real</h1>',
    // All heading levels
    '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>',
    // Heading with nested tags
    '<h1><strong>bold</strong> heading</h1>',
    // Mixed content
    '<p>paragraph</p><h1>heading</h1><p>another paragraph</p>',
    // Byte-order mark
    '\ufeff<h1>BOM test</h1>',
    // Null bytes
    '<h1>null\u0000byte</h1>',
    // Extremely long attribute value
    '<a title="' + 'x'.repeat(10000) + '">link</a><h1>Real</h1>',
    // Many attributes
    '<h1 a="1" b="2" c="3" d="4" e="5">many attrs</h1>',
    // Mixed quotes
    '<h1 title=\'single quoted\'>mixed quotes</h1>',
    '<h1 title="double quoted">double</h1>',
    // Backtick in attribute (not a quote in HTML)
    '<h1 title=`backtick`>backtick attr</h1>',
    // Script with JSON-LD inside but not first
    '<script>var x=1;</script><h1>Real</h1>',
    // Script with application/ld+json but as part of another type
    '<script type="text/javascript+application/ld+json">var x=1;</script><h1>Real</h1>',
    // Real heading after deeply nested comment
    '<!-- a --><!-- b --><!-- c --><h1>Real</h1>',
    // Unclosed double quote in attr
    '<h1 title="unclosed>Real</h1>',
    // Tab and newline in tag
    '<h1\n\tclass="foo">whitespace in tag</h1>',
    // Self-closing script (not valid HTML but seen in wild)
    '<script type="application/ld+json" />',
    // Multiple titles
    '<html><head><title>First</title><title>Second</title></head><body><h1>Body</h1></body></html>',
    // Non-ASCII tag name (invalid but shouldn't throw)
    '<h\u00e9>non-ascii tag</h\u00e9>',
    // Overlapping tags
    '<b><i>overlap</b></i><h1>Real</h1>',
    // Space before >
    '<h1 >space before close</h1>',
    // Attribute without value
    '<h1 hidden>hidden attr</h1>',
    // Numeric character reference in hex with uppercase
    '<h1>&#x3E;</h1>',
    // Numeric character reference in hex with lowercase
    '<h1>&#x3e;</h1>',
    // Tab after tag name
    '<h1\t>tab after name</h1>',
    // Newline in attribute
    '<h1 title="line\nbreak">linebreak attr</h1>',
    // Multiple lines
    '<h1>line1\nline2</h1>',
    // Extremely large hex entity  
    '<h1>&#x7FFFFFFF;</h1>',
    // Valid high codepoint
    '<h1>&#x10FFFD;</h1>',
    // Emoji reference as hex entity
    '<h1>&#x1F600;</h1>',
  ];

  // Add more random-like fragments with seeded determinism
  const seed = 0xDEADBEEF;
  let state = seed;
  const mulberry32 = () => {
    state |= 0; state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  const tagNames = ['h1','h2','h3','h4','h5','h6','p','div','span','a','b','i','em','strong'];
  const entities = ['&amp;','&lt;','&gt;','&quot;','&#39;','&#x26;','&#38;','&nbsp;'];
  
  for (let i = 0; i < 120; i++) {
    const len = Math.floor(mulberry32() * 200) + 1;
    let frag = '';
    let depth = 0;
    for (let j = 0; j < len; j++) {
      const r = mulberry32();
      if (r < 0.15 && depth < 5) {
        const tn = tagNames[Math.floor(mulberry32() * tagNames.length)];
        frag += '<' + tn + '>';
        depth++;
      } else if (r < 0.25 && depth > 0) {
        const tn = tagNames[Math.floor(mulberry32() * tagNames.length)];
        frag += '</' + tn + '>';
        depth--;
      } else if (r < 0.28) {
        frag += entities[Math.floor(mulberry32() * entities.length)];
      } else if (r < 0.30) {
        frag += '<!-- random comment ' + Math.floor(mulberry32() * 100) + ' -->';
      } else {
        const c = String.fromCodePoint(Math.floor(mulberry32() * 0x80) + 0x20);
        frag += c;
      }
    }
    // Close remaining tags
    while (depth > 0) {
      const tn = tagNames[Math.floor(mulberry32() * tagNames.length)];
      frag += '</' + tn + '>';
      depth--;
    }
    fragments.push(frag);
  }

  for (const frag of fragments) {
    const bytes = Buffer.from(frag, "utf-8");
    let result;
    try {
      result = extractFromHtml(bytes);
    } catch (e) {
      assert.fail(`extractFromHtml threw on fragment: ${JSON.stringify(frag.slice(0, 100))}: ${e.message}`);
    }
    
    // Verify every evidence span slices back exactly
    for (const h of result.headings) {
      const slice = bytes.subarray(h.evidence.start, h.evidence.end).toString("utf-8");
      assert.ok(slice.length > 0, `heading evidence slice empty for: ${JSON.stringify(frag.slice(0, 100))}`);
    }
    for (const l of result.links) {
      const slice = bytes.subarray(l.evidence.start, l.evidence.end).toString("utf-8");
      assert.ok(slice.length > 0, `link evidence slice empty for: ${JSON.stringify(frag.slice(0, 100))}`);
    }
    for (const j of result.jsonLd) {
      const slice = bytes.subarray(j.evidence.start, j.evidence.end).toString("utf-8");
      assert.ok(slice.length > 0, `jsonld evidence slice empty for: ${JSON.stringify(frag.slice(0, 100))}`);
    }
  }
});

// =============================================================================
// R14 regression tests: HTML attribute parsing correctness
// =============================================================================

test("R14-1: HTML backslash does not escape the closing quote", async () => {
  const html = '<a title="C:\\">x</a><h1>Real</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.deepEqual(result.headings.map(h => h.text), ["Real"],
    "backslash in attribute value must not escape the closing quote");
});

test("R14-2a: whitespace before equals preserves JSON-LD attribute", async () => {
  const html = '<script type = "application/ld+json">{"a":1}</script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 1, "should find one JSON-LD item");
  assert.deepEqual(result.jsonLd[0].data, { a: 1 });
  // exact byte spans
  const slice = bytes.subarray(result.jsonLd[0].evidence.start, result.jsonLd[0].evidence.end).toString("utf-8");
  assert.equal(slice, html);
});

test("R14-2b: whitespace before equals preserves canonical link attribute", async () => {
  const html = '<link rel = "canonical" href = "https://example.com/x">';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.canonical, "https://example.com/x",
    "whitespace around = must not drop canonical href");
});

test("R14-3a: first duplicate HTML attribute wins — text/plain first means no JSON-LD", async () => {
  const html = '<script type="text/plain" type="application/ld+json">{"a":1}</script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.deepEqual(result.jsonLd, [], "first type is text/plain, must not parse as JSON-LD");
});

test("R14-3b: reversed attribute order gives one JSON-LD item", async () => {
  const html = '<script type="application/ld+json" type="text/plain">{"a":1}</script>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.jsonLd.length, 1, "first type is application/ld+json, must parse as JSON-LD");
  assert.deepEqual(result.jsonLd[0].data, { a: 1 });
});

// =============================================================================
// R15-2: whitespace collapse after removed markup
// =============================================================================

test("R15-2: whitespace collapse after CDATA removal", async () => {
  const html = '<h1>a <![CDATA[ b ]]> c</h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings[0].text, "a c",
    "whitespace after removed CDATA must collapse to single space");
});

// =============================================================================
// R17 regression tests: entity prototype safety and quote-aware textBetween
// =============================================================================

test("R17-1: &constructor; &toString; &hasOwnProperty; &__proto__; &valueOf; stay literal", async () => {
  const html = "<h1>&constructor; &toString; &hasOwnProperty; &__proto__; &valueOf; &amp;</h1>";
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text,
    "&constructor; &toString; &hasOwnProperty; &__proto__; &valueOf; &");
});

test("R17-2: double-quoted > in inner attribute does not leak into heading text", async () => {
  const html = '<h1>A <span title="x>y">B</span></h1>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "A B");
});

test("R17-3: single-quoted > in inner attribute does not leak into heading text", async () => {
  const html = "<h1>A <b data-x='1>2'>B</b> C</h1>";
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].text, "A B C");
});

test("R17-4: double-quoted > in link inner attribute does not leak into link text", async () => {
  const html = '<a href="/p"><span data-x="1>2">Label</span></a>';
  const bytes = Buffer.from(html, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].text, "Label");
});

// R18 performance regression tests — each gets a timeout so the old quadratic
// code FAILS rather than hangs on large inputs.
test("R18-T1: textBetween linear with ASCII inline tags (2 MiB)", { timeout: 15000 }, () => {
  const N = 250000;
  const unit = "<b>x</b> ";
  const html = `<html><body><a href="/x">${unit.repeat(N)}</a></body></html>`;
  const bytes = Buffer.from(html, "utf-8");
  const t0 = Date.now();
  const result = extractFromHtml(bytes);
  const elapsed = Date.now() - t0;
  const expectedText = ("x ".repeat(N)).trim();
  assert.ok(elapsed < 2000, `expected <2000ms, got ${elapsed}ms`);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].text, expectedText);
});

test("R18-T2: textBetween linear with UTF-8 + quoted '>' inline tags (2 MiB)", { timeout: 15000 }, () => {
  const N = 70000;
  const unit = '<i class="q>">\u00e9\u4e2d</i> ';
  const html = `<html><body><a href="/x">${unit.repeat(N)}</a></body></html>`;
  const bytes = Buffer.from(html, "utf-8");
  const t0 = Date.now();
  const result = extractFromHtml(bytes);
  const elapsed = Date.now() - t0;
  const expectedText = ("\u00e9\u4e2d ".repeat(N)).trim();
  assert.ok(elapsed < 2000, `expected <2000ms, got ${elapsed}ms`);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].text, expectedText);
});

test("R18-T3: findCloseTagCi linear with unclosed <a> (2 MiB)", { timeout: 15000 }, () => {
  const N = 150000;
  const unit = '<a href="/x">t ';
  const html = `<html><body>${unit.repeat(N)}</body></html>`;
  const bytes = Buffer.from(html, "utf-8");
  const t0 = Date.now();
  const result = extractFromHtml(bytes);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `expected <2000ms, got ${elapsed}ms`);
  assert.deepEqual(result.links, []);
});

test("R18-T4: findCloseTagCi linear with unclosed <h2> (2 MiB)", { timeout: 15000 }, () => {
  const N = 300000;
  const unit = '<h2>t ';
  const html = `<html><body>${unit.repeat(N)}</body></html>`;
  const bytes = Buffer.from(html, "utf-8");
  const t0 = Date.now();
  const result = extractFromHtml(bytes);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `expected <2000ms, got ${elapsed}ms`);
  assert.deepEqual(result.headings, []);
});

test("R18-T5: deterministic decode work — O(n) not quadratic", { timeout: 15000 }, () => {
  // Wrap Buffer.prototype.toString to count every utf-8 decode range.
  const origToString = Buffer.prototype.toString;
  let decodeSum = 0; // Σ (end - start) over every .toString(...) call
  Buffer.prototype.toString = function (...args) {
    // Only count calls with explicit start/end (utf-8 byte-range decodes).
    // args[0] is encoding, args[1] is start, args[2] is end.
    if (typeof args[0] === 'string' && args[0].toLowerCase() === 'utf-8') {
      if (typeof args[1] === 'number' && typeof args[2] === 'number') {
        decodeSum += args[2] - args[1];
      } else if (typeof args[1] === 'number' && args[2] === undefined) {
        decodeSum += this.length - args[1];
      }
    }
    return origToString.apply(this, args);
  };

  try {
    // Build T1-style page at n = 20000
    const unit = "<b>x</b> ";
    const nSmall = 20000;
    const htmlSmall = `<html><body><a href="/x">${unit.repeat(nSmall)}</a></body></html>`;
    const bytesSmall = Buffer.from(htmlSmall, "utf-8");

    decodeSum = 0;
    extractFromHtml(bytesSmall);
    const sumSmall = decodeSum;

    // Build T1-style page at n = 40000
    const nLarge = 40000;
    const htmlLarge = `<html><body><a href="/x">${unit.repeat(nLarge)}</a></body></html>`;
    const bytesLarge = Buffer.from(htmlLarge, "utf-8");

    decodeSum = 0;
    extractFromHtml(bytesLarge);
    const sumLarge = decodeSum;

    // Assert: decode total ≤ 4× input byte length at each n
    const limitSmall = 4 * bytesSmall.length;
    const limitLarge = 4 * bytesLarge.length;
    assert.ok(sumSmall <= limitSmall,
      `n=20000: decoded ${sumSmall} > 4×${bytesSmall.length}=${limitSmall} (quadratic?)`);
    assert.ok(sumLarge <= limitLarge,
      `n=40000: decoded ${sumLarge} > 4×${bytesLarge.length}=${limitLarge} (quadratic?)`);

    // Assert: 40000 total ≤ 2.2× 20000 total
    const ratio = sumLarge / sumSmall;
    assert.ok(ratio <= 2.2,
      `decode ratio ${ratio.toFixed(1)} > 2.2 (expected linear growth, got ${sumSmall}→${sumLarge})`);
  } finally {
    Buffer.prototype.toString = origToString;
  }
});

test("R18-D2: Unicode whitespace collapse — NBSP, U+3000, U+2028, U+FEFF, U+2002", () => {
  // These five characters must be collapsed to a single space, matching the old /\s/ behaviour.
  const chars = [
    { name: "U+00A0 NBSP", ch: "\u00a0" },
    { name: "U+2002 EN SPACE", ch: "\u2002" },
    { name: "U+2028 LINE SEPARATOR", ch: "\u2028" },
    { name: "U+3000 IDEOGRAPHIC SPACE", ch: "\u3000" },
    { name: "U+FEFF BOM/ZWNBS", ch: "\ufeff" },
  ];
  for (const { name, ch } of chars) {
    const html = `<h1>a${ch}${ch}b</h1>`;
    const bytes = Buffer.from(html, "utf-8");
    const result = extractFromHtml(bytes);
    assert.equal(result.headings.length, 1, `${name}: should find heading`);
    assert.equal(result.headings[0].text, "a b",
      `${name}: expected "a b", got ${JSON.stringify(result.headings[0].text)}`);
  }
  // Link text
  for (const { name, ch } of chars) {
    const html = `<a href="/x">a${ch}${ch}b</a>`;
    const bytes = Buffer.from(html, "utf-8");
    const result = extractFromHtml(bytes);
    assert.equal(result.links.length, 1, `${name} link: should find link`);
    assert.equal(result.links[0].text, "a b",
      `${name} link: expected "a b", got ${JSON.stringify(result.links[0].text)}`);
  }
  // ASCII control — tab
  {
    const html = "<h1>a\t\tb</h1>";
    const bytes = Buffer.from(html, "utf-8");
    const result = extractFromHtml(bytes);
    assert.equal(result.headings[0].text, "a b", "tab: expected 'a b'");
  }
});

// R19-T6: href-less anchors with a later close tag stay linear
test("R19-T6: href-less anchors with a later close tag stay linear", { timeout: 15000 }, () => {
  const N = 150000;
  const body = '<a name="n">x'.repeat(N) + '</a><a href="/later">Later valid anchor</a>';
  const bytes = Buffer.from(body, "utf-8");
  const start = Date.now();
  const result = extractFromHtml(bytes);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `expected under 2000 ms, got ${elapsed} ms`);
  assert.equal(result.links.length, 1, "should find exactly one link");
  assert.equal(result.links[0].href, "/later");
  assert.equal(result.links[0].text, "Later valid anchor");
});

// R19-T7: empty-href anchors with a later close tag stay linear
test("R19-T7: empty-href anchors with a later close tag stay linear", { timeout: 15000 }, () => {
  const N = 150000;
  const body = '<a href="">x'.repeat(N) + '</a><a href="/later">Later valid anchor</a>';
  const bytes = Buffer.from(body, "utf-8");
  const start = Date.now();
  const result = extractFromHtml(bytes);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `expected under 2000 ms, got ${elapsed} ms`);
  assert.equal(result.links.length, 1, "should find exactly one link");
  assert.equal(result.links[0].href, "/later");
  assert.equal(result.links[0].text, "Later valid anchor");
});

// R19-C1: control — href-less then normal anchor still yields one link
test("R19-C1: href-less anchor then normal anchor yields exactly one link", () => {
  const body = '<a name="n">skip</a><a href="/x">X</a>';
  const bytes = Buffer.from(body, "utf-8");
  const result = extractFromHtml(bytes);
  assert.equal(result.links.length, 1, "should find exactly one link");
  assert.equal(result.links[0].href, "/x");
  assert.equal(result.links[0].text, "X");
});
