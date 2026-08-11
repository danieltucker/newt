/**
 * HTML to something a model reads well.
 *
 * Not a sanitizer — every caller here is either working with HTML that was
 * sanitized when it was written, or with a remote page whose markup is being
 * thrown away rather than rendered. This strips markup because tags are tokens
 * the reader is paying for and the model gains nothing from them, and it keeps
 * block boundaries as newlines so paragraphs and list items don't run together
 * into one wall of prose.
 *
 * Lives in its own module because both halves of the article context need it:
 * articleContext.ts for the copy Newt already has, articleFetch.ts for the page
 * it goes and reads. Importing one from the other would be a cycle.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
