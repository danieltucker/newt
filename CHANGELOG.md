# Changelog

Notable changes to Newt, newest first.

## v1.16.0 - Bring your own model

**2026-08-11**

Newt can now use an AI model, and the model is yours. There is no shared key and
no Newt account with a provider behind it: you paste your own API key into
Settings → AI, the provider bills you, and until you do, none of the features
below exist in the interface at all. That last part is deliberate - a button
that only ever opens a settings screen is an advert, not a feature.

Three providers work: **Claude**, **ChatGPT**, and anything that speaks the
OpenAI format at a URL you supply, which covers Ollama, OpenWebUI, LM Studio,
vLLM, OpenRouter and the rest. One entry rather than six, because they are all
the same wire format and six adapters would have been six copies of one file.

**Self-hosted endpoints have to be reachable from the internet.** A LAN address
- `192.168.1.50:11434`, `localhost` - is refused. This is the one constraint
people will hit, and it is not an oversight: Newt accepts sign-ups, and a server
that will fetch any URL an account gives it is a server that will map the
network it is sitting in on that account's behalf. Publish the box through a
tunnel or a reverse proxy with TLS and it works.

### Research

A new page, at **/research**. Ask a question, get an answer, keep asking. The
thread is saved and stays in the sidebar, which is the difference between this
and a chat window - research you cannot come back to next week is not research.

Every answer ends with a few suggested directions to take it next. They come
back inside the same reply rather than from a second request, and they fill the
composer rather than sending straight off, so you can edit one before asking it.

Any article or post has a **Research** button beside Repost. It opens a thread
with the article's text and the comments you can already see as context - the
ones you cannot see are not sent, which is worth saying plainly: a model must
not be able to read a comment its reader can't.

When the thread has got somewhere, **Condense into a post** turns it into a
draft and drops you into the composer with it. Private, like every new post: a
button that says condense does not publish.

### Proofread

The composer has a **Proofread** button. It reports and does not rewrite -
spelling and grammar first, then clarity, consistency, and matters of taste
last and lightly. Each finding is a quote from your draft, a reason, and a
suggestion; you make the change. A button that silently swaps an author's
sentences for a model's is ghostwriting, and it is very hard to undo after
you've accepted twenty of them.

### Asking from the search bar

`/ask your question` opens it in Research rather than sending you to a website.
With an article open, that article and its comments go up as context, which is
the whole reason to ask here instead of in another tab.

It briefly had its own overlay with a "continue in Research" button underneath.
That was one surface too many: the overlay could not take a follow-up, could not
be returned to, and its only real affordance was handing the question to the
page that could do both. So the question goes there in the first place.

The `/c` shortcut is unchanged for anyone with no model connected - it still
opens claude.ai, which is the right answer when there is no key.

### Research can read your own feed

Your model cannot browse and has a training cutoff, which makes it weakest
exactly where you are most curious: what happened recently. But you are already
subscribed to publications covering it, and Newt has been storing those articles
all along.

So when you ask about something current, Newt works out what the question is
about, searches the articles already in your feed, and hands the relevant ones
over. Answers cite them as ordinary links, and the articles consulted are listed
above the reply while it writes.

The search terms come from one call to the *cheapest* model your provider
offers, not the one answering - working out that a question about "iOS 27"
should search for "iOS 27" is not a reasoning problem. That call is skipped
entirely when you follow no feeds, when the question isn't the kind a news
archive answers, and when you turn it off in Settings → AI.

Nothing is fetched. This is a search over articles already in the database,
scoped to your own subscriptions.

### What it costs, and how to spend less

The first cut of these features had one setting for everything: a very high
token ceiling and whatever the model did by default, which on a reasoning model
means thinking hard about everything. A few questions came to real money. None
of that spend was chosen, because there was no dial.

There are four now.

**Answer length.** Brief, Balanced or Thorough, in Settings → AI. It sets how
hard the model thinks as well as how much it writes, which matters because
thinking is billed as output and output is the expensive half. Brief is not a
crippled mode - for "what is this" and "summarise this article" it is the right
answer. Balanced is the new default.

**A model picker that leads with price.** The old field was free text with a
list of suggestions, which is fine if you already know which one is cheap and
useless otherwise. Every model now shows its tier, its approximate per-million
rates, and what it costs relative to the cheapest option on that provider.
Prices are indicative and link out to the provider's own page, which is
authoritative. Free text is still there behind a link, so a model released the
week after a Newt version is still reachable.

**The cheap model does the mechanical work.** Proofreading and feed-search
planning now run on the smallest model your provider offers - Haiku rather than
Opus, mini rather than 4o - because they are mechanical jobs where the
expensive model buys nothing. Research and condensing still use the one you
picked.

**Prompt caching.** A thread re-sends its system prompt and the article it
started from on every follow-up. Those are now cached, which is the difference
between paying for them once and paying for them on every question.

And so you can see all of it: each answer says roughly what it cost, from the
token counts your provider reports. Approximate, shown only for models with a
known price, and switchable off.

Self-hosted endpoints get no cost estimates at all, which is the honest answer -
Newt has no price list for your own hardware.

### Notes for anyone self-hosting

There is one new required environment variable, **`LLM_KEY_SECRET`**. It
encrypts the stored API keys, and the server refuses to start in production
without it. Back it up alongside the JWT secrets: nothing is corrupted if it
changes, but every stored key becomes undecryptable and everyone has to paste
theirs in again.

Stored keys are encrypted at rest with AES-256-GCM and are **never** sent back
to the browser - not to the owner, not to an admin. The settings screen shows
the last four characters and nothing else, which is why changing a key means
pasting a new one rather than editing the old one.

If you run your own reverse proxy in front of Newt, the AI routes stream and
need buffering off and a generous read timeout. `client/nginx.conf` has both,
with the reasoning next to them; anything in front of that - Nginx Proxy
Manager, Cloudflare - needs the same, or answers arrive all at once at the end
instead of a word at a time.

## v1.15.0 - Two devices, one phone, and the keyboard

**2026-08-10**

### A note written in two places is no longer a note written in one

Notes opened on a computer whose tab had been sitting there since the morning
deleted the work done since. Nothing about that was a race or a glitch: the
notes tree is saved whole, so the first thing typed in that tab posted its
entire copy of the notes - the morning's copy - over everything written in
between. A complete, well-formed set of notes, from several hours ago.

Two things had to change, and only the second of them is a guarantee.

**The console goes and reads the notes again when it opens.** Settings are
fetched once, at sign-in, and nothing had ever gone back to look. So a tab left
open was showing an old tree and had no way to find out.

**And a save now says which version it was based on.** The server hands out a
revision number with the notes and takes it back with every write. When it
matches, the write is stored as sent. When it doesn't - or when it isn't sent at
all, which is what a tab running older code looks like - the two versions are
merged instead of one replacing the other:

- A note both sides have is resolved by when it was last edited. The later text
  wins.
- A note only the writer has is new work, and is kept.
- A note only the server has is work the writer never saw, because it was
  written after that page loaded. That is kept too.

The last rule is the one that costs something. A *permanent* delete - Recently
Deleted, then Delete for good - made in a tab that is behind looks exactly like
a note that tab has never heard of, so the note comes back. That is the right
way round: an unwanted note that reappears is a nuisance, and a wanted one that
vanishes is gone. Ordinary deletes are unaffected; those leave the note in place
with a stamp on it, and merge like any other edit.

When a save does get merged, the console says so and takes the result on board,
including any note that arrived from the other machine - without disturbing the
sentence being typed, which is newer than either version and wins on that basis.

### The keyboard stops sitting on top of what you are writing

Text being typed in a note on a phone kept disappearing under the keyboard.

The console is a fixed, full-height panel, and a fixed element is laid out
against a viewport that iOS does not shrink when the keyboard comes up. So the
console was still full height, the writing surface still ended at the bottom of
the screen, and the bottom third of it was behind the keys - along with the
caret, which is generally the part you are looking at.

Newt now measures the keyboard and stops the console at the top of it. The
caret is scrolled back into view when that happens, because the line that was
two thirds down the editor is off the end of a shorter one. The reading list,
which is also full-bleed on a phone, gets out of the way the same. This is
measured rather than declared: the one-line viewport setting that would do it
is Chromium-only, and the phone this was reported on runs WebKit.

### The reading list stops sliding sideways

Articles drifted left and right under a vertical swipe.

A list-layout row is built from parts that all refuse to shrink - the byline,
the two action pills, the delete button - with only the headline giving way. On
a 360px screen they want around 500px between them, so the row overflowed, and
a container that overflows sideways becomes a sideways scroller. Vertical swipes
on a two-axis scroller drift. The Visited pill is the last 68px of that total,
which is why it looked like the cause of it.

Rows wrap now: headline, byline, controls, a line each. Deliberately three lines
and not two - sharing a line between the byline and the controls means one of
them has to give, and shrinking the byline erases the publisher's name while
letting the line break where it likes makes a row two lines tall or three
depending on whether that article happens to have been visited. It is still
comfortably the densest of the three layouts. The scroll area is also nailed to
one axis, so nothing can bring the drift back.

### The Save menu comes up from the bottom on a phone

Pressing the caret beside Save appeared to shove the page upward and open
nothing.

It was doing exactly that. The menu opens upward, because the button is at the
foot of a card - and the cards scroll inside a box, so a card near the top of
that box had its menu cropped by the box's own edge. Focusing the first item
then scrolled the list to bring the cropped menu into range, and the handler
that closes a menu when its list scrolls away closed the menu that had caused
the scroll.

Below 640px it is a sheet at the bottom of the screen instead: fixed to the
viewport, so there is nothing to crop it and nothing to scroll it into view, as
tall as the list of folders needs, and where a thumb already is. It also stays
open while a new folder is being named, which the keyboard's own scroll used to
close.

### Adding an article by URL

The URL field was a plain text field, so a phone treated an address as prose -
capitalising it, autocorrecting the host to the nearest English word, and
offering a space bar where the slash should be. It says it is a URL field now,
in the reading list and in Add Link both. Typing `verge.com/article` without a
scheme still works.

### The refresh button turns up after the phone has been asleep

Picking up a phone after a couple of hours gave a feed with no way to refresh it
- which is the page that most needs one.

The button was scheduled by a timer set fifteen minutes ahead, and a sleeping
phone suspends the page. Depending on how long it was out, that timer fires
late, fires at once on waking, or never fires at all because the page was
discarded and restored with its timers gone. How old the page is is now read off
a stored timestamp, which survives all of that, and it is re-read on every way a
page can come back: switching tabs, a back/forward-cache restore, and the window
simply regaining focus. Those are three different events and none of them
substitutes for the others.

### Find and replace stays under the toolbar

In the blog editor, stepping through search results scrolled the field being
typed in off the top of the screen while the formatting bar stayed put. The find
bar is sticky now, and comes to rest against the bottom of the toolbar - a
distance that has to be measured rather than written down, since the toolbar
wraps to as many rows as the width allows and grows another whenever the caret
is in a table.

### The welcome screen offers the whole list

Picking feeds on a new account showed one or two publications per heading — a
short list drawn from a longer one, on the reasoning that a directory is a poor
welcome. What it actually did was hide most of the list from the only person who
has never seen it, and leave eleven categories looking like they held a couple
of feeds each.

All of them are on that screen now, grouped under their category, with the
"Select all" that was already there for anyone who wants a whole heading. It
scrolls; that is a smaller cost than not knowing what is on offer.

Sport is now **Sports**, which is what it should have been called, and two more
feeds join it: CBS Sports and Yahoo Sports. The rename only affects categories
created from here on — a category already made from the old list keeps the name
it was given, and can be renamed in Manage feeds.

### A bookmark's menu stops disappearing behind the reading list

On the panel layout, the ··· menu on a tile in the bottom row opened straight
into the reading list panel beneath it — and behind it. Edit and Delete were
the two entries far enough down to be covered.

The menu had a layer set that should have carried it over the top, and it never
applied: lifting a tile under the cursor is a `transform`, and a transformed
element becomes the ceiling for everything inside it. So the menu was only ever
sorted against its own tile. The tile is what gets raised now, while its menu is
open — above the reading list and the feed under it, below the search bar it may
scroll past.

### A folder can be made while you are saving a link

Adding a bookmark offered the folders you already had and nothing else. If the
site in front of you didn't belong in any of them, the link had to be abandoned
— close the dialog, make the folder from the sidebar, then start again and
retype the address.

**Add a link** now ends its row of folder chips with **+ New folder**. Choosing
it opens a name field and the same twelve colours a folder is picked from
anywhere else, in place, with the address you typed still on screen. The folder
it creates is selected on the way back, so the link lands in it — and the page
moves to that folder once the link is saved, which is where the thing you just
filed now lives.

It is inline rather than a second dialog stacked on the first: one of those
would have covered the half-filled form it was opened from.

### Newt pages can now be found

Every URL Newt served carried the same title — *"Newt - a new tab worth opening"* —
and an empty page underneath it. That is what a search engine saw at a post's
address, and what Slack, Discord and iMessage saw when someone pasted a link:
nothing to draw a card from, so every Newt link anyone has ever shared unfurled
as a blank rectangle.

Public pages now describe themselves. A post carries its own title, its excerpt,
its cover image, its author and its dates; a profile carries the author's name
and post count; a tag carries what it is a tag for. Nothing about the app
changes — the page you see is the page you saw — but a link to it is no longer
anonymous.

**Comments are part of the post.** Public comments on a post are now rendered
into that post's page, which is where they belong: a comment answering an
article is about that article's subject, and the same comment listed on its
author's profile is not about anything. Profile comment tabs stay out of search;
so do `/a/` thread pages, which are discussions of *other people's* articles and
have no business competing with them.

**Your posts have an index.** A profile lists an author's posts as ordinary
links, with real Previous and Next pages. That sounds like nothing, and it was
the single largest gap: the app's own profile uses infinite scroll, and a search
engine cannot press "load more" — so everything below the first screen of every
author's work was unreachable no matter how good the description was.

**Tags are places.** `#editors` on a post used to lead to that author's other
posts about editors. It now leads to `/t/editors` — everyone's. Each tag page is
also a feed, so a tag is something you can follow, in Newt's own reader or
anywhere else. The narrower view is still on the author's profile.

**A front door.** `/recent` lists the latest public posts. Being on it is earned
rather than automatic: an author needs 2FA enabled, more than one post, and no
report a moderator has upheld in the last 90 days. That is not about quality —
it is that a page listing everything new, on a site anyone can register for, is
worth spamming, and the cost of spam lands on everyone's pages rather than the
spammer's.

There is deliberately no "hide from search" setting. Public, friends and private
already say what they mean, and a fourth axis would have made a clear choice
muddy. What that does mean is that un-publishing has to work properly, so a post
that stops being public now answers a real 404 rather than a page that says
"not found" while quietly telling Google to keep it — the difference between
leaving the index and staying in it forever.

Two more things, for the record. Newt's sitemap holds off on accounts less than
a day old that have not enabled 2FA: their posts are still public, still
linkable and still unfurl, they are simply not handed to Google on day one.
And model-training crawlers — GPTBot, ClaudeBot, CCBot and the rest — are turned
away by default. That is reversible with a single setting if you self-host and
want it the other way; the default is the one that can be changed its mind about
later.

### A bookmarked site asks before it joins your feed

Saving a bookmark used to go looking for the site's feed and subscribe you to it
without saying so. That guess is right often enough to be tempting — you bookmark
the sites you read — and wrong in a way that was hard to trace: a link to a shop,
a bank or a ticket site would quietly start dealing its marketing blog into the
river, and the only place that said where it came from was Manage feeds.

Now it asks. When the site behind a new bookmark turns out to publish a feed, a
small card appears in the bottom corner — *"The Verge publishes a feed. Follow
it?"* — with **Follow** and **No thanks**. It waits a few seconds and then goes
away on its own, and waits longer than that if the pointer is on it. Escape
dismisses it. Saying no just closes the card; nothing is remembered against the
site, so the offer is still there in Manage feeds under "from your bookmarks".

Nothing asks twice about a feed you already follow, however it was spelled when
you added it, and nothing asks at all if RSS is turned off in Settings. The
unread badge on the tile is unaffected either way: that only ever needed to know
where the feed was, not whether you subscribe to it.

One thing that was missing before: a feed reached this way is now checked against
the blocked-domain list, which the *Add feed* box has always done and this path
never did.

### Search reaches the whole feed, not the last two days of it

Searching for an article you know you read and not finding it was not a ranking
problem. The article was not in the data being searched.

Search ran entirely in the browser, over a snapshot: when the page loaded it
fetched the 200 newest articles across every subscription and filtered that
array by substring. Two hundred sounds generous until you count what a dozen
active feeds publish in a day. Anything older than roughly a day or two of your
own river had fallen out of the window, and no headline you could type would
bring it back — while the same article was still sitting in its feed, one click
away, which is exactly how you'd find out.

Search now runs on the server, against every article in every feed you follow,
as far back as the database goes. Three things change with it:

**It reads the summary, not just the headline.** A local paper's piece titled
*"District votes on Maple and Oak"* is about a school closing whether or not it
says so above the fold.

**It matches words rather than letters.** "school" finds "schools". Partial
words match too, which is what finally connects a search for *closing* to a
headline about a *closure* — the two don't share a stem, but they share a
beginning.

**Results are ranked, and a headline beats a passing mention.** A match in the
title counts for several times a match in the summary, so the article about the
thing comes before the weekly roundup that mentions it.

`#tag` searches work the same way and now reach the whole archive too, matching
tags that start with what you typed.

### A search result opens in Newt

Picking an article from the search box used to hand the browser straight to the
publisher. That is the right destination eventually and the wrong one first: a
result you picked out of a dropdown is usually a *was this the one?*, and
answering it shouldn't cost you the page you were on.

Articles now open the reader — the piece, its comments, and the save controls,
with **Open original** there when you do want to go. A post written on this
instance opens its own page instead, since that page already is the Newt page
for it; the reader would only show a syndicated copy of something we host. The
badge on the result says which you'll get, *Article* or *Post*.

Bookmarks are unchanged. A bookmark is somewhere you've already decided to go.

Two things worth saying plainly. Searching only ever looks at feeds **you**
subscribe to — feed articles are stored once and shared by everyone on the
instance, so this is enforced by deriving the search from your subscription list
rather than by filtering afterwards, and there is a test whose only job is to
fail if that ever stops being true. And articles you've dismissed are included:
waving something out of the river is not the same as saying you'll never look
for it, and a search box that hides what you're asking for is not one you'd ask
twice.

## v1.14.0 - The feed asks before it moves

**2026-08-07**

### One card per story

Articles were appearing twice. Not a rendering fault - the feed genuinely held
two of them, and there are two ordinary ways for that to happen:

- **One publisher, two feed addresses.** `arstechnica.com/feed` and
  `feeds.arstechnica.com/arstechnica/index` are different subscriptions carrying
  identical articles. Nothing stops you following both, and nothing said you had.
- **Aggregators.** Daring Fireball or Hacker News links to a piece you also
  follow at the source. Both feeds delivered it; both were right to.

Each copy is its own row and has to be - articles are shared between everyone on
the instance, and read state hangs off the row. So the river now shows one card
per *story*, keyed on the canonical article URL: the same key comments have
always threaded on, which is why a duplicated article shared its comments while
appearing twice. On the account this was found on, 76 duplicate cards went.

The copy kept is the one that surfaced most recently. That is the only coherent
choice in a reverse-chronological feed - keeping the earliest would file a story
that resurfaced this morning back at its original date, halfway down the page,
where nobody would find it.

Two things had to change underneath for that to be stable rather than merely
usually right:

- **Read and dismissed now apply to the story, not the copy.** Otherwise
  dismissing a card would hide the copy you pressed and promote its twin into
  the same slot on the next load - the article would come back, once, for no
  visible reason. Marking read had the quieter version: the Unread count
  disagreed with the list under it.
- **The tiebreak between two copies is no longer `fetchedAt`,** which is
  rewritten on every poll and rewritten *en masse* by a 304. The winner changed
  from one refresh to the next, so a card swapped its title and source, and a
  story you had read came back unread. It uses `firstSeenAt`, which is written
  once.

The totals count stories too, so "Load more · N remaining" and the Unread chip
describe the feed you are actually looking at. Those two counts are the only raw
SQL in the server: `COUNT(DISTINCT …)` is the one thing Prisma cannot express
without shipping a row per story to the process to call `.length` on.

Not everything is caught. Nine articles in the same sample were the same piece
published at genuinely different URLs, which no key derived from the address can
match up.

### Nothing arrives while you're reading

The feed used to be whatever the server had when the page was drawn, and the
only way to find out whether anything had happened since was to reload the whole
app. Now it counts.

An open feed asks every few minutes - and immediately when you come back to a
tab you left open - whether anything has landed since it was drawn. If something
has, a pill says so. Nothing is inserted until you press it. That is the whole
design: articles appearing under the cursor push down what you were reading and
change where your next click goes, so arrivals are announced rather than
performed. The pill is fixed to the top of the window rather than sitting in the
page, because a banner in the flow would shove the grid down to tell you that
nothing had shoved the grid down.

Pressing it redraws from the top and **keeps the filters you set**. Switching
category still clears them - a site you picked in Tech usually isn't in Local -
but asking for new articles is not asking to be put back at the start of your
own view.

### A refresh that turns up when it's wanted

The count only reports what the background refresher has already collected, so
on its own it would say "nothing new" about a feed nobody had polled in
twenty-nine minutes. Something has to go and ask the publishers.

That something is **not a toolbar button**. A page drawn a minute ago has
nothing to refresh, and a permanent control implies otherwise - it invites
pressing, and every press fans out into outbound requests to answer a question
with no answer in it. So once the page has been open for fifteen minutes, a
**Refresh feed** button appears floating at the bottom of the window. Using it
resets the clock and it goes away again.

It stays out of the way while the new-articles pill is up: at that point they
would be two buttons competing to be pressed, and the pill is the better one -
it already knows there is something to show. The two are complementary rather
than alternatives.

Feeds checked within the last minute are skipped server-side, so leaning on the
button costs nothing.

Counting "new" turned out to need a new column. `fetchedAt` looks like the right
one and isn't: every refresh rewrites it, and a 304 rewrites it for *every* item
in the feed at once, to stop the cleanup sweep deleting a feed that simply
hasn't published lately. Counting off that column would have reported an entire
unchanged feed as new. `firstSeenAt` is written once, when an item is created,
and never again.

### The filters are a box; the actions are above it

"Mark all read" was a double-tick in a row of filter chips, dressed exactly like
them, and on a narrow window its label dropped and the glyph was all that was
left - an unlabelled button that marks every article you have. One of those
controls is undoable and the other is not, and they were the same shape.

They're two bands now. Actions on top, right-aligned: Mark all read, Manage
feeds, and the layout switch. The things that narrow the feed sit underneath in
a box of their own, which is what makes them read as one set of controls for one
purpose. "Mark all read" keeps its words at every width; only "Manage feeds"
goes icon-only when the row runs short - you set your feeds up once.

### Making a category is where you go looking for one

Creating a feed category was a field pinned to the bottom of the Following tab,
below every subscription you had. Filing a feed somewhere new meant scrolling
past the whole list, naming the category, scrolling back up, and choosing it
from a menu you had been standing next to the entire time.

It is in that menu now - a **+ New category…** entry at the foot of the category
dropdown, in both places the dropdown appears: the add-feed row, and a feed's
own editor. Choosing it swaps the menu for a name field, and the category it
creates is selected on the way back, which is the choice you were trying to make
when you went looking for it.

A native dropdown holds strings, not text fields, so the entry has to be a verb
sitting among the destinations rather than another destination. It is last in
the list for the same reason.

### The list layout is a list again on a phone

List and Cards looked the same on a phone, and the rule doing it said why: "a
row with no width to spare is just a card - let it stack." So it stacked, with
the full-size headline, the meta on its own line, and the action strip back with
its hairline. But a phone is where a dense list earns the most, because it is
where the least fits on screen - stacking took the one layout meant for scanning
and made it the layout meant for reading.

It stays a row that wraps now: the headline claims the first line, everything
else shares the line under it. An article costs about 135px instead of about
270px - four on screen where there were two.

It isn't one line per article, and deliberately so. The comment and save
controls are 44px because that is what a thumb needs, and the labels stay
because an unlabelled bookmark glyph is the same guessing game the feed's
toolbar was just rid of. Trading those away would buy one more article per
screen and cost more than it bought.

### Feeds that weren't findable, and one that was arriving empty

Paste a YouTube channel, a Bluesky profile, a subreddit or a GitHub repo and
Newt now finds the feed. All four publish perfectly good ones; general discovery
just couldn't get to them.

- **YouTube** advertises its feed 730 KB into a 2.5 MB page, well past what we
  read. A `/@handle` is resolved through the page's canonical link - deliberately
  *not* the `"channelId"` in the inlined JSON, which on a channel page belongs to
  a recommended channel in the sidebar and would subscribe you to a stranger.
- **Reddit** advertises nothing and hides its feeds behind a `/.rss` suffix,
  which neither half of discovery looks for.
- **GitHub** repos offer releases, falling back to commits so a project that
  hasn't cut a release yet doesn't resolve to an empty feed.
- **Bluesky** was already discoverable - and was silently delivering nothing.
  Its posts have no `<title>`, because they're posts, and the parser dropped
  every item that lacked one. A titleless item is headlined by its first line
  now, the way every other reader shows them.

That last one uncovered a second bug it was hiding: hex character references
(`&#xA;`, a line break) were never decoded, only decimal ones. Bluesky writes
every line break that way, so its titles arrived with the escape sequences
printed in them - and it would have been affecting any feed that used hex
entities anywhere.

### Your YouTube subscriptions, without your Google account

Type a YouTube address into Manage feeds and it offers, on one line, to bring
over everything you subscribe to. Take it up and it explains how: export your
subscriptions from Google Takeout, drop `subscriptions.csv` in, and the channels
arrive as a pickable list filed under a YouTube category. It folds away again
once used.

The explanation is only ever shown to someone who has just typed a YouTube
address. A paragraph about Google Takeout has no business sitting open in front
of people who were never thinking about YouTube.

A file rather than a "Connect YouTube" button on purpose: YouTube won't name
your subscriptions without an OAuth grant through the YouTube Data API, which
means a Google Cloud project, a client secret in the deployment, a consent
screen in review, and a standing read-scope on your Google account - a great
deal of machinery, and a permanent one, for a list that changes a few times a
year and that Takeout hands over as a 2 KB file. The file is read in the
browser; nothing leaves it until you pick something and press Follow.

### More to follow

The suggested list has grown from 15 feeds to 61, and from four categories to
eleven - Programming, Design, Business, Gaming, Sport, Health and Cars join
Tech, News, Science and Culture. Every entry was fetched and confirmed to return
items before it went on the list, and the ones that didn't survive that check
are named in the source so nobody re-adds them: AP News now answers 401 to its
own RSS address, New Scientist refuses a non-browser user agent, and Sports
Illustrated's feed is gone.

Paywalled publishers are on the list rather than excluded from it - the FT, the
Economist, the NYT, Bloomberg, WSJ, Stratechery, the New Yorker, the Atlantic
and others - because their feeds are useful even unpaid, and leaving them out
would drop a good deal of the best writing on the web. What is not acceptable is
finding out at the wall, so each one is labelled where it is offered:
**Subscription** for all of it, **Partly paywalled** for a publisher that allows
a few free reads. The two are kept apart deliberately; flattening both to
"paywalled" would make a metered publisher sound like a locked one.

The first-run picker doesn't show all of them - it offers 18, spanning
every category, because that screen has to feel like a beginning and stops
working as forty-odd choices across eleven headings. The full list lives in
Discover, which is where you go when you *are* browsing.

### A broken feed now stops being fetched

Nothing ever gave up on a feed. A URL that had answered 404 for a month was
still being fetched every thirty minutes for as long as one subscriber kept
opening it, and because articles expire after seven days, what they were opening
was an empty entry that never explained itself. The admin panel could see the
failure count climbing and there was nothing to do about it short of deleting
the feed - which is the wrong lever, since a dead URL is usually a moved one and
the feed row is what everyone's subscription points at.

So there is now a middle setting. After **twenty consecutive failures** - about
ten hours of a feed being continuously broken, well past a bad morning at the
origin - the feed switches itself off and stops being fetched. Nothing is
deleted, ever, automatically: the feed, its subscriptions and its whole refresh
history stay exactly where they were, and switching it back on is one button and
retries immediately. Admins get one notification when it happens, separate from
the repeating "this feed is failing" alert, because it is the message that means
articles have actually stopped arriving for everyone subscribed.

The **Feeds** tab shows why a feed is off rather than only that it is, since the
three reasons want different responses - it gave up, an admin switched it off,
or its domain is blocked.

### Sorting and filtering the feed list

The feed list sorts by any column - subscribers, stored articles, failure count,
last checked, last success, title, address - and filters by All, Healthy,
Failing, Switched off, Blocked or Dormant. Both happen on the server, so they
order and narrow *every* feed on the instance rather than the page that happens
to be loaded, which is the same reason search already worked that way.

Failing and Switched off are deliberately separate. They were one thing before
this release, and folding them together now would bury the handful of feeds that
need a decision among the many having a bad hour.

### Blocking domains

There is a blocklist. Two shapes, because there are two questions:

- **example.com** blocks that domain and everything under it - news.example.com,
  feeds.example.com - but never notexample.com.
- **.xyz**, with the leading dot, blocks a whole domain extension.

Matching is on whole labels in both cases. The obvious implementation - does the
hostname end with this text - makes a rule for `example.com` block
`notexample.com`, and `.ru` block anything ending in those two letters. That
kind of over-block is silent: nobody reports a feed they were never allowed to
add in the first place.

A rule applies to feeds that already exist, not only to new subscriptions.
Adding one switches off everything stored that matches it and says how many,
because a block that only closed the front door while the server carried on
fetching the host would be a block in name only. New subscriptions are checked
against the *resolved* address rather than the one typed, so a shortener or a
redirect through a clean domain doesn't walk past the rule, and an import skips
just the blocked entries instead of failing the whole file.

Removing a rule doesn't automatically bring those feeds back - it asks. A block
usually outlives the rule that expressed it, and quietly restarting fetches to a
host somebody objected to is not a decision to make on anyone's behalf.

## v1.13.1 - The foot of a card

**2026-08-06**

### The staircase at the foot of a card

Comment and Save sit at the foot of every feed and reading list card, one at
each end of a row. When the card was too narrow to hold both, Save dropped to a
second line - and stayed pinned to the right edge, because the thing putting it
there was a margin that survives the wrap. So you got a step: Comment at the
left of one line, Save at the right of the next, with the hairline above them
and nothing else on either.

The row does the aligning now, which means both ends know when they've wrapped.
And below the width where the two genuinely don't fit, each pill takes the whole
line, which is a better target anyway.

That rule used to be a `max-width: 380px` media query, and that was the actual
bug: a card is between 200px and 400px wide no matter how wide the window is,
because the grid packs in as many columns as will go. The one case that breaks -
a narrow card on a big screen - is the one a viewport query can never see. It
asks the card now.

The read time went the same way while it was in view: "· 3 min" was breaking
across two lines on a tight card. It stays whole, and the publisher's name gives
up the width instead, which it was already set up to do.

## v1.13.0 - Finding things in Settings

**2026-08-06**

### The sections are a list, not a row of tabs

Settings has grown six sections and thirty-odd controls, and on a narrow window
they were a row of tabs across the top: six shrunken labels sharing the width of
a phone, each one a small target next to five others. Wide windows already had a
rail down the left, which is the shape that works - so now that shape is the
rule, and the narrow case is a drill-down rather than a squeeze. You get the
list of sections, you pick one, and the panel takes over the window with a Back
button to return. The section list and a section are never on screen together
down there, because there isn't room for both to be legible.

The breakpoint is 720px, and it's watched in JavaScript rather than done in CSS
alone: the two layouts are different trees, not the same tree restyled.

### Search

A field above the section list, and it looks for the individual setting rather
than the section holding it. Searching "2fa" finds the authenticator, "dark"
finds the theme, "new tab" finds both the one about search results and the one
about bookmarks - each result says which section it lives in, since those two
otherwise read identically.

Picking one goes to the section, scrolls the control into the middle of the
panel and rings it for a moment. Reading is a long page; being dropped at the
top of it and told the setting is *somewhere below* is not an answer.

### It opens where you'd expect

Opening Settings landed on Search - the second section - because that was the
default when Search was the first thing in the list. It opens on Account now,
which is where the list starts. Opening it from "Edit profile" still goes
straight to Account, including on a phone, where it skips the list entirely:
the caller named a section, so it means it.

### The scroll stays in the panel

Scrolling inside Settings moved the feed behind it instead - past the end of a
section the leftover scroll was handed to the page underneath, and a wheel over
the dimmed area went there directly. The page behind is now held still while the
panel is up, and the panel's own scroller keeps what it's given.

### On a phone, a big panel is the screen

A dialog is a card floating on a dimmed page, and the dim is how it says there
is something behind it. On a phone there is no room to say that: the margin, the
border and the shadow are drawn out of the same 390 points the content is
fighting for, and the notes console was spending a rounded frame's worth of
clutter on every edge to hold a window that had nothing beside it anyway.

So the large panels take the whole screen below their narrow breakpoint -
Settings, the admin panel, the notes console, the backtick console, the article
overlay, Manage feeds, Notifications and the first-run feed picker. The reading
list and the article reader already did; this is the rest of them following.
Each keeps a visible way out, which is the thing the backdrop was doing before:
a ✕, or Back where a panel is one level down. The backtick console had neither
a ✕ nor an outside to click once it filled the screen, so it has one now, in
place of the keyboard hints that a phone can't use.

The small form dialogs - add a link, new folder, edit a bookmark, save an
article, report something - stay as dialogs. Three fields blown up to fill a
screen reads as heavier than the job is, and they already fit.

### Bookmarks on a narrow window

Below 900px the bookmarks rail moves into the hamburger, where it was a 272px
dropdown capped at 72% of the screen height. The rail carries a pin grid, so
width is what it can least afford to give away, and a folder list is exactly
the thing that wants height. On a phone it's a sheet now: full width, filling
everything under the bar, with a ✕ of its own. The bar stays put above it, so
the button that opened it is still where you left it.

### The admin panel on a narrow window

Eight tabs in a 180px rail beside a table of users wants about 900px before
either half is readable, and there was nothing telling it what to do below that.
It gets the same treatment Settings did: the rail becomes a list you drill into,
one tab at a time, with Back and ✕.

### The feed stops introducing itself

The "FEED" heading named the only feed-shaped thing on the page, and the number
beside it counted every article ever fetched - a figure that only goes up and
that answers a question about the database rather than about your reading. Both
are gone. What's left to read is the unread chip's job, and it sits directly
below where they were.

### Opening an article marks it read

Read state only ever came from scrolling: an article counted once it passed the
top of the screen. So opening the last card on screen, reading the whole thing
and coming back left it unread, because nothing had scrolled anywhere. Viewing
an article is the stronger signal of the two and it simply wasn't wired up.

Now it is - opening the reader, or following the title or the cover image out to
the site, marks that article read. Middle-clicking into a background tab counts
too. This happens whether or not "Mark articles read as you scroll" is on: that
setting is about what scrolling past does, not about whether reading counts.

### Saved articles show which ones you've opened

Coming back from an article used to put a prompt across the head of its card -
"Done with this?", a Keep, a Remove and a countdown bar draining away. It asked
a question at the worst possible moment, it covered the controls you were most
likely to want next, and to deliver it at all the reading list had to force
itself open on your return.

It's gone. In its place the card does what a followed link has always done: it
goes quiet. A saved article you've opened fades back - dimmer surface, a muted
headline, cover art at about half strength - and carries a small "Visited" tag
at the end of its meta line. Pointing at the card brings it all the way back,
because visited is a resting state, not a verdict. Favorites keep their gold.

The tag is there as well as the fade, not instead of it: a fade only says
"visited" when there's an unvisited card next to it to compare against, and it
says nothing at all if you can't pick up a small shift in opacity.

Nothing is filed or deleted for you, and nothing asks. The mark is kept in this
browser rather than on your account - the same bargain every browser makes with
visited links - so it shows up the instant you click rather than after a round
trip, and it doesn't follow you to a different machine.

### The shelves stop running off the edge

The row of shelves at the top of the reading list held its one line by scrolling
sideways. That works under a thumb and is close to invisible under a mouse:
there was no scrollbar, no arrows and nothing at the edge to say the row carried
on past the last chip you could see. A folder off the end of it was a folder you
didn't have.

Nothing in that row scrolls now. It measures what it can actually show and folds
the rest into a menu at the end - "3 more", and everything inside it with its
colour and its count, the same as on the rail. If the shelf you're looking at is
one of the folded ones, the menu button wears its name instead of the count, so
the row still says where you are. Narrow the window and shelves move into the
menu one at a time; widen it and they come back out. The reading list itself
never leaves the rail.

### "Save article" is "Add"

The button that adds an article by URL said "+ Save article", which was the
third thing on that screen called Save: every card has one, so does the reader,
and both of those file an article you already have onto a shelf. This is the
only control in the room that brings a new one in, so it says Add, and so does
the button that commits the form it opens.

It also looks like a button now. It was borderless accent text sitting between
the Filters chip and the layout switch - the one control in that row shaped like
a link that had wandered in. Same pill, same height, same border as its
neighbours, and Cancel takes exactly its place while the form is open rather
than shifting the row.

### The switches slide

The layout switch - on the feed, in the reading list and on a site page - and
the visibility switch in the post composer both said which option was on by
painting one segment and unpainting another in the same frame. The selection
teleported: two things to notice, and nothing joining them, so a three-way
switch never quite told you it was you who moved it.

They have a highlight that travels now. It slides from segment to segment, and
on the visibility switch it grows and shrinks on the way, because Public,
Friends and Draft are three words of different lengths - the box is measured
rather than stepped, so it also holds together when that switch drops to bare
icons on a narrow window.

Nothing animates on arrival. A control that opens on its third segment starts
there rather than sliding across to it, which would be claiming something had
just changed. And "Reduce motion" turns the travel off entirely: the highlight
still moves, it just stops taking time about it.

### The feed's controls are one row

"Mark all read" and "Manage feeds" sat in a right-aligned strip of their own,
with the filter chips starting at the left margin underneath. Nothing was ever
on the left of that top row, so the two rows shared no edge and the buttons
floated above a page-wide gap.

They're all feed-level controls doing the same job, so they're one row now:
what narrows the feed on the left, what acts on the whole feed on the right,
with the layout switch at the end. That fixes the alignment and gives the
articles back a whole strip of vertical space.

On a phone there are six controls and no arrangement of them fits on one line,
so the row wraps - but it wraps to the left, under the chips, instead of being
shoved to the far right of a line of its own. Right-aligning it was how the
original gap got in, and an auto margin was quietly recreating it one breakpoint
down. The two buttons also drop their labels there and keep their icons, with
the words still on them for a screen reader.

Those icons were 12px, which is fine as an accent beside a label and far too
small once the icon *is* the button - they were specks in a 40px square. They
are sized to the control now, here and in the layout switch, whose three
segments were mostly empty space around a 13px glyph.

### Everything you press is the same size

The reading list's toolbar was the clearest case: the favorites chip, the
Filters chip and the layout switch sat in one row at three different heights,
and the two chips rode above the switch rather than level with it. On a phone
the gap widened, because two of the three grew for a thumb and the other two
didn't - the layout switch had no touch size at all, and the favorites pill came
out 8px shorter than the chip beside it.

That happened because every component picked its own numbers, so the answer is
not to re-pick them here. There are three heights now, in `tokens.css`, and each
control names the one it wants: nested controls like the Undo inside a dismissed
card's pill, standalone ones like chips and switches and icon buttons, and
fields with the buttons that commit them. Each grows on touch, all at once, so a
row that lines up with a mouse lines up with a thumb.

The numbers come from the shell bar, which was already the one place where every
control agreed - so the bar you look at on every screen didn't have to move for
the rest of the app to line up with it. What did move: the filter chips and
active-filter pills on the feed and in the reading list, both layout switches,
the favorites control and its manager, the filter dropdowns and every row inside
them, the shelf rail, the save and comment pills at the foot of a card, the card
action buttons, close buttons, the ··· menus on bookmarks and folders, the
buttons on site and profile pages, and the footers of the feed manager, add
link, new folder, report and save dialogs. The search box now matches the
buttons on either side of it, which it never quite did.

Corners had the same problem, and it was most obvious in the feed: a strip of
rounded-rectangle buttons sitting directly on top of a strip of pills, which
read as two toolbars from two different apps. The rule was already there in the
shell bar - labelled controls are pills, icon-only squares are rounded - it just
wasn't written down anywhere, so half the app followed it by accident. Now it's
stated, and it holds: Mark all read, Manage feeds, Open original, Follow and the
buttons on site and profile pages are pills like the chips they sit beside, the
layout switch and the card action squares stay rounded like every other icon
button, and dialog buttons stay rounded to match the fields they submit.

The post editor's action bar had all of this at once: the visibility switch came
out 29px with a 10px corner, the Save button beside it 32px with a 9px one, and
"Allow comments" was a short label being centred against tall neighbours. The
same went for the rest of the writing side - My posts, the post page's top bar,
sign in, the friends and notifications rows, the import dialog, and the edit
bookmark and edit folder footers, where the delete button was 44px and the two
buttons that replace it when you arm it were 36, so the row changed height the
moment you pressed Delete.

Two things also came out of this. The favorites manager's remove button was
16px, which is a glyph rather than a target, and it is the only way to take a
favorite off the list - it's 22px now, 30 on touch; the × on a tag chip got the
same treatment. And the reading list still carried the styles for its old
per-tag filter chips, replaced when the filters folded into the dropdown; those
are gone.

The editor's own toolbars and Settings are not in this pass.

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
