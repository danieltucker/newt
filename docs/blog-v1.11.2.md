# Every site you read now has a page of its own

**Newt v1.11.2**

Newt has always been good at answering "what's new?" The feed is one river of
everything you follow, newest first, and the reading list is the pile you've
promised yourself you'll get to.

What it was bad at was the other question. You read something from Ars Technica,
you liked it, and you wanted to know what else they'd published lately — and
what you'd already saved from them. There was nowhere to go. The feed mixes a
hundred publishers together on purpose, and the reading list is sorted by when
you saved things, not by who wrote them.

That's what this release adds.

## Site pages

Click the site name on any card — the little domain under a feed article, the
source line on a reading-list card — and you land on that publisher's page.

It gathers up everything you've got from that one site:

- **Everything it's published** that's come through your feed, newest first,
  including things you've already read or dismissed.
- **Everything you saved from it**, and whether each one is still on your
  reading list or filed away in your Library.
- **Where it sits in your setup** — whether you follow it, which category it's
  filed under, whether it's bookmarked, and which folder that bookmark is in.
- **A link straight to the site itself**, which is where the byline used to go.

The addresses are short and guessable: `newt.page/s/arstechnica.com`,
`newt.page/s/theverge.com`. You can type one in.

If you *don't* follow the site, the page says so and offers to start — which is
handy when a link you clicked from somewhere else turned out to be worth
keeping.

Bookmark tiles have a **Site page** entry in their menu too, so you can get
there from your bookmarks without waiting for a card to show up in the feed.

### A note on where the byline goes now

The site name on a feed card used to open the site's front page in a new tab.
That was a bit redundant: the headline right above it already takes you to the
article, and the article is on the site. So the byline now answers the question
the headline can't — "what else have this lot been up to, and what have I kept
from them" — and the site's own home page is one clearly labelled button away.

## Comment links on profiles actually go somewhere

If you clicked one of your own comments on your profile, the address bar
changed and… nothing else happened. You were left staring at the same page.

That's fixed. Clicking a comment now opens the article it was on, scrolls down
to your comment, and gives it a brief highlight so you can see which one you
landed on. Links you share work the same way — send someone a link to a comment
and it opens right on that comment, not at the top of a long thread.

## The reading list counts the pile

Above your reading list there's a line that tells you how much reading you've
banked. It used to say things like "about 40 minutes of saved reading" — which
sounds precise but doesn't help much. Forty minutes could be one long feature or
eight quick ones, and those are very different decisions.

It now tells you both:

> Your reading list has 5 articles which should be about 17 minutes. Maybe clear
> one out.

Same rotating tone, more useful number.

## Newt is called Newt

Newt started life as a personal new-tab page, and the old name was still hiding
in a few corners. The browser tab said "Newt.ab". The sign-in card said "New
Tab". The "back" buttons on profiles and posts said "← New Tab". The console's
`version` command answered with the old name too.

They all say Newt now. The installed app is called Newt. A couple of places
nobody ever looks — the name Newt gives when it fetches a feed, and the label
it uses when you set up two-factor authentication — got the same treatment.

**Does this affect you?** Only cosmetically, with one small exception: if you
already use an authenticator app with Newt, your app will keep showing whatever
label it saved when you set it up. Nothing has changed about your account, and
you don't need to re-enrol. Anyone setting up 2FA from now on will see "Newt".

## Anything you need to do?

No. Site pages appear on their own, and everything else is either a fix or a
change of wording. Nothing about your bookmarks, feeds, reading list, Library or
posts has moved.

If you self-host, this release adds a database migration — run
`prisma migrate deploy` as usual when you update.
