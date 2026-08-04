# Changelog

Notable changes to Newt, newest first.

## v1.11.1 — Phones, and knowing what broke

**2026-08-05**

A maintenance release in two halves: making the app usable on a phone, and
making failures visible to whoever runs the instance.

### The phone zoom

Newt kept ending up slightly zoomed in on iOS, with the edges of the page cut
off and a sideways scroll that shouldn't have been there. The cause was Safari,
and it wasn't really a bug: WebKit zooms the page whenever you focus a form
field whose text is smaller than 16px, and it never zooms back out. Almost every
field in the app was under that line — search was 14px, sign-in 15px, the
comment title 13px. They're all 16px on touch devices now.

Pinch-zoom is untouched. The other way to stop Safari doing this is to disable
zooming for everybody, which is not a trade worth making.

### Search on a phone

Search was sharing the top bar with the logo and three buttons, which left it
about 130 pixels wide — narrower than most of the hints it rotates through. On
narrow screens it's now a magnifier that expands across the whole bar when
tapped, with a Cancel to put the rest back.

### Writing a comment on a phone

The visibility switch and the Cancel/Post buttons were on one row that didn't
fit, so the buttons were pushed off the right edge and what was left sat
underneath the floating notes button. The buttons now drop to their own line
below the switch, aligned left, at a size a thumb can hit — and matching each
other, which they previously didn't.

### A way out of the sign-in page

The sign-in card looked like a dialog but had no close. It has one now, and
Escape works. The card was also a flat 400px wide, which is wider than a phone —
it now fits the screen it's on.

### Errors are visible now

New **Errors** tab in the admin panel, in two parts:

- **Feed health.** A feed that stopped resolving used to be indistinguishable
  from one that hadn't published lately — it failed quietly and the articles
  just stopped. Failures are now recorded per feed, with what went wrong, how
  many checks in a row have failed, and when it last worked.
- **Recent errors.** Unhandled server errors, with the route, the response
  status, the account that hit it and the stack trace. There was no error
  handler at all before this, so these reached the browser as a bare 500 and
  were kept nowhere.

Entries are pruned after 30 days. This is a diagnostic log, not a record like
the audit trail. Ordinary 4xx responses aren't errors and aren't listed.

### Admin alerts

Admins are now notified in-app when someone registers, and when a feed has
failed three checks in a row. A feed that stays broken is repeated at most once
a day rather than every five minutes, and a feed that recovers and breaks again
is reported again.

### Chart values on hover

The admin charts carried native tooltips on the marks themselves, which meant
reading a value involved hitting a 4px dot or a 2px bar. Hovering anywhere over
a chart now shows the date and the value for that day, with a guide line to the
point being read. Works by touch too.

## v1.11.0 — Feeds grow up

**2026-08-04**

Feeds used to live *inside* bookmark folders. That meant the articles a site
published were only visible once you'd clicked into the right folder, and adding
or removing a feed meant knowing that it was hidden in that folder's edit dialog.
This release takes feeds out of the bookmarks entirely and gives them a home of
their own.

### One feed, not one per folder

The feed now shows everything you follow, newest first, whichever folder you
happen to be looking at — or none at all. Bookmarks and feeds are separate
things now: where a *link* is filed says nothing about how its publisher should
be sorted in a reader.

### Feed categories

Feeds can be grouped into categories of their own — "Tech", "Local news",
"Auto", whatever suits — and the feed can be narrowed to one of them. These are
not bookmark folders; they exist purely for reading, and a feed can be moved
between them without losing its name or its history.

Deleting a category never unfollows what was in it. Those feeds fall back to
**Uncategorised**, which is a normal place to keep things, not an error state.

### Manage feeds

A new **Manage feeds** dialog, reachable from the feed header — including when
the feed is empty, which is exactly when you need it.

- **Paste a site, not a feed URL.** Type `npr.org` and Newt finds the feed
  itself. If a site doesn't publish one, it says so ("No feed found at
  example.com") rather than silently saving a subscription that never produces
  an article.
- **Rename, re-point, re-file.** A feed that changes address is still the same
  subscription, and keeps the name you gave it.
- **Import from your bookmarks.** Bookmarked sites that publish a feed you're
  not following are offered in one list — tick the ones you want. Unfollow a
  feed and its site reappears there, so this is reversible in both directions.
- **Create and rename categories** without leaving the dialog.

### Suggested feeds for new accounts

New accounts get a one-time picker offering a curated set of publications across
Tech, News, Science and Culture, so a new reader isn't an empty one. Nothing is
followed unless you pick it, skipping is a single click, and it never asks twice.

### One filter control, on the feed and the reading list

The row of every tag in the list is gone. Category, site and topic are now a
single **Filters** menu, with whatever you've actually chosen shown as a chip you
can click to remove. **Unread** keeps its own button, since it carries a count
and is the one people reach for without thinking.

The reading list uses the same control, and gains a **site** filter it never had.
Topics there can still be starred as favourites — the star moved into the filter
menu alongside the topic it belongs to.

### Smaller things

- "Feed Articles" is now just **Feed**.
- **Mark all read** respects the category you're looking at, so clearing Tech
  doesn't quietly wipe the news you hadn't got to.
- Dismissing an article now dismisses it everywhere, rather than only in the
  folder you happened to be in.
- A feed with no title of its own falls back to its hostname instead of showing
  a blank byline.
- The folder edit dialog is now just name, colour and delete.
- Console: `refresh` re-fetches every feed you follow, and reports feeds rather
  than folders.
- Removed an unused RSS widget component and the endpoint that served it.

### Upgrading

The database migration runs automatically and preserves what you have:

- Every bookmark folder that actually held feeds becomes a feed category of the
  same name and colour. Folders with no feeds don't become empty categories.
- Following the same feed from two different folders now collapses to a single
  subscription — in one combined feed, two copies would deal every article
  twice. The older of the two is kept.
- Articles you'd dismissed stay dismissed. Where the same article had been
  dismissed in more than one folder, those records merge into one.

No configuration changes are needed.
