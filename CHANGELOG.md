# Changelog

Notable changes to Newt, newest first.

## v1.12.2 - The editor, in the dark and in markdown

**2026-08-05**

### The writing surfaces follow the theme

The block editor, the notes console and the comment composer set their own
light colours, on the theory that an editor is "paper" and should look the same
wherever it is embedded. In a dark app that meant a white slab in the middle of
the screen: the one surface you stare at for an hour was the one that never
turned the lights off.

Paper is a theme now. The values live in `styles/tokens.css` as a `--paper-*`
ramp with a set per theme, the way `--fav` and `--draft` already do it. It
stays its own ramp rather than folding into the page's `--surface`/`--text`
because a document surface needs finer gradations than chrome does - three
surface levels, five weights of text - and a little more contrast. Light is
unchanged, to the pixel: those are the values that were hardcoded.

### Pasting markdown

The editor has always understood markdown as you type - `## ` makes a heading,
`- ` makes a list. What it could not do was take a whole document at once, so
pasting anything written elsewhere (a note from another app, a chunk of a
README, an answer from a chatbot) dropped a wall of asterisks into the page and
left you to reformat it by hand.

It now converts on the way in: headings, both kinds of list, to-dos with their
checked state, quotes, fenced and indented code, rules, tables, and the inline
run of bold, italic, strike, code and links.

Two guards keep it out of the way. Prose pastes as prose - the trigger is a
construct unambiguous at the start of a line, or a paired marker, not a stray
asterisk or a hyphen. And a clipboard carrying real HTML is left to the
browser, since that is the better source; this is for the case where plain text
is all there is.

Anything it does not recognise survives as a paragraph with its text intact. A
paste never loses words.

### Markdown as you type, inline

Closing a pair of markers formats what is between them: `**bold**`, `*italic*`,
`_italic_`, `__bold__`, `~~struck~~`, `` `code` ``. The command menu has
advertised this all along - every inline entry lists its markdown in the hint -
and it simply was not wired up.

It costs one character comparison on every keystroke that is not a marker, and
a short regex list walk on the few that are, so it is not something you will
feel. `some_file_name` and `2 * 3 * 4` are left alone, and nothing fires inside
a code span or a code block, where the markers are the content.

There is no `***both***`: on an empty line `***` is already the horizontal rule
trigger, and a rule that works in one half of a paragraph and not the other is
worse than not having it. Pasted markdown still handles it.

### The formatting bar stays put

In the blog composer the page scrolls, and the formatting toolbar used to leave
with it - four paragraphs into a post there was no way to reach bold but the
keyboard. It now sticks under the action bar, which sticks under the shell bar.
The action bar publishes its own measured height rather than being assumed,
because it wraps to two rows on a narrow window.

### Heading levels in the selection bubble

The bar that appears when you select text carried a lone **H2** button, which
was an odd offer: of the editor's three heading levels, one was reachable there
and the other two were not. It is a picker now. It reports the level you are
on, and opens onto all three plus the way back to body text, each row set at
the size it produces.

## v1.12.1 - Saving a feed article shows up straight away

**2026-08-05**

Pressing **Save** on a feed card greys it out to say the article is dealt with.
Three separate things were standing between the press and the grey.

The card was waiting for the server. It only changed once the save had been
written and acknowledged, and if you picked a shelf from the caret menu it
waited on two round trips, not one. It commits locally now and reconciles
behind the scenes, which is what every other write in the reading list already
did. If the save turns out to have failed, the card comes back: full colour,
receipt gone, unread count restored, still in your feed.

The grey then cross-faded in over a quarter of a second. This is the receipt
for a button you just pressed, so it snaps.

And the card had a hover state that lifted it back to nearly full colour. The
pointer is on the card at the moment you press Save, because that is how Save
got pressed, so a saved article went straight into the lifted state and only
greyed properly once you moved the mouse away. It is gone. The controls keeping
their colour is what says the card is still live, and they say it whether or
not you are hovering.

The dialog is left alone. It holds the screen while it saves and stays open if
that fails, so it is already its own feedback, and by the time it is out of the
way the card behind it has changed.

## v1.12.0 - The reading list gets a room of its own

**2026-08-05**

### The reading list is a place you go into now

It used to be a section on the new tab that unfolded behind a chevron. Both
states were wrong. Collapsed, it was the word "Reading list" and a number, and
nothing about it said whether you were keeping up. Expanded, it was a wall of
cards between the bookmarks and the feed, and the only way past it was to
scroll.

The new tab carries a launcher instead. The count sits in a tile at a size you
can read across the room with its unit under it, beside the reading time, the
line that says whether to worry, and a short stack of covers showing what is
actually on the pile. A meter runs along the bottom edge.

It changes colour as the pile grows, walking Newt's own gradient backwards:
teal while the list is short, sky as it builds, violet past nine articles and a
brighter orchid past fifteen. So the state of your reading is something you
take in rather than something you go and check, and it never has to borrow the
colours of a warning to say so. A stack of things you chose to keep is not an
error.

Opening it gives you the whole thing: the pile, and every folder you have filed
into, in one rail across the top. That was the half a collapsible section could
never carry. The articles you kept were here and the folders you put them in
were on your profile, and nothing showed you both. Filters, the layout switch
and **Save article** sit in one strip that stays put while the cards scroll
under it.

On a phone it takes the whole screen, which is the right answer for the one
surface in the app you open in order to read.

The numbers on the launcher count the pile only. A folder is somewhere you put
something on purpose, and counting it back at you as unfinished business would
punish the tidying.

### Site pages draw themselves three ways

`/s/<domain>` had one shape: a column of rows. It now takes the same **List /
Cards / Magazine** switch the feed and the reading list have, remembered as its
own setting, because a river you skim and one publisher's back catalogue don't
want the same layout. Magazine gives the lead piece the width and turns
art-less articles into text cards; both lists on the page follow the one switch.

### Done with this?

The prompt you get back to after reading an article had a gold button and a red
one, both gradients, neither of which is a colour used anywhere else in Newt.
It read as a cookie banner sitting on the card. It is the same pair of pills the
rest of the app uses now: **Keep** filled in the accent, **Remove** bordered and
going red only on approach. It wraps onto a second line on a narrow card rather
than rendering the question as "Don…".

### Saved cards keep their buttons

Saving an article from the feed greys the card, which is right: it says the
thing is dealt with. But the fade was applied to the whole card, so the Save
pill, the comment bar and the dismiss button greyed out with it, and a working
control at half opacity with no colour looks exactly like a disabled one. The
article and its artwork fade; everything you can still press keeps its colour.

### Also

- The post-read prompt no longer gets swallowed on a same-tab return. It was
  consumed by a check that ran before the reading list had finished loading.

## v1.11.2 — Site pages, and calling things by their name

**2026-08-04**

### Site pages

Every publisher now has a page of its own at `/s/<domain>` — `newt.page/s/arstechnica.com`,
say. It gathers up everything this account holds from that one site: what its
feed has published, what you saved from it, whether you follow it, which
category it's filed under, whether it's bookmarked, and whether its feed is
currently broken.

The domain is the key because it's the only identifier a feed subscription, a
bookmark tile and a saved article all already carry — they share no id.

You get there by clicking the site name on a card. On a feed card the byline
used to go straight out to the site's front page, which was the one destination
the card already offered (the headline is the article, and the article is on the
site). It now answers the more useful question — what else has this lot
published, and what have I kept from them — with a **Visit site** button one
click away. Reading-list cards' source lines are links now too, and bookmark
tiles have a **Site page** entry in their menu.

If you don't follow the site, the page offers to start.

### Comment links on profiles went nowhere

Clicking a comment on a profile changed the address bar and left you looking at
the same page. The reader is an overlay the app shell owns, and nothing was
watching for a same-page navigation to `/a/<id>` — so the URL moved and nothing
opened. It now opens the article's thread and scrolls to the comment you
clicked, flashing it briefly so it's obvious which one that was. Shared links
carry the comment too (`/a/<id>?c=<comment>`).

### Reading-list nudge counts the pile

Half the rotating nudges above the reading list quoted only a duration — "about
40 minutes of saved reading" doesn't tell you whether that's one long read or
eight short ones. Every one of them names both now: "Your reading list has 5
articles which should be about 17 minutes."

### Naming

The browser tab said **Newt.ab**; it says **Newt - a new tab worth opening**.
The installed-app name is **Newt**. The sign-in card said "New Tab", the "back"
buttons on profiles and posts said "← New Tab", and the console's `version`
command answered `Newt.ab` — all of them are the product's actual name now. Two
places nobody looks also stopped saying it: the user-agent Newt sends when
fetching a feed, and the issuer in new authenticator-app enrolments (existing
enrolments keep the label your app already stored).

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
