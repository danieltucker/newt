// Where Share sends people, and what the row says once it has sent them.
//
// Lifted out of CommentsPanel in 1.21.0, unchanged. Two surfaces share it now -
// the comment bar on a card and the newt button's Share row - and the second
// one had no business importing the whole comment panel to get at one function.

import { articlePathFor } from './articleUrl';
import { blogRefOfUrl, blogPathFor } from './blogUrl';

// What the Share row says once it has done something. Constants because the
// success string is also the test for "show the tick".
export const COPIED_OK = 'Link copied';
export const COPIED_FAIL = 'Couldn’t copy';

/**
 * The link Share puts on the clipboard: this instance's page for something.
 *
 * Which page that is depends on what the thing is, and getting this wrong is
 * what the first version of Share did:
 *
 *  - An **article** published elsewhere has no page here of its own, so the
 *    Newt page for it is the reader at `/a/<id>`. That is where its comment
 *    thread lives, and it is the reason to send this link instead of the
 *    publisher's URL.
 *  - A **post written on this instance** already has a page - `/u/<author>/
 *    <slug>` - with the writing itself on it, the author's name, and the same
 *    comment thread (threads key on the post's URL, so the two cannot diverge).
 *    Wrapping it in `/a/` instead sent readers to a generic reader rendering a
 *    feed item *about* the post, whose only way through to the post was the
 *    toolbar's "Open original".
 *
 * This is the same rule noteEmbed already applies when it decides where a
 * reference card points; see commentsHref there.
 *
 * `blogRefOfUrl` is what tells them apart, and it is origin-checked - a feed
 * can carry any link at all, and a lookalike /u/<name>/<slug> path on somebody
 * else's host must never be rewritten into one of ours.
 */
export function shareLinkFor(url: string): string {
  const post = blogRefOfUrl(url);
  const path = post ? blogPathFor(post.username, post.slug) : articlePathFor(url);
  return `${window.location.origin}${path}`;
}

/**
 * Put a share link on the clipboard and say what happened.
 *
 * `navigator.clipboard` is absent over plain http, which is exactly how someone
 * reaches a self-hosted instance on their own network - so the failure is
 * reported rather than swallowed, and the caller is told to leave the message
 * up long enough to read it. Resolves to the string to show and how long to
 * show it; it never rejects, because a copy that didn't happen is an outcome,
 * not an exception.
 */
export function copyShareLink(url: string): Promise<{ text: string; holdMs: number }> {
  const done = navigator.clipboard?.writeText(shareLinkFor(url));
  if (!done) return Promise.resolve({ text: COPIED_FAIL, holdMs: 1600 });
  return done.then(
    () => ({ text: COPIED_OK, holdMs: 900 }),
    () => ({ text: COPIED_FAIL, holdMs: 1600 }),
  );
}
