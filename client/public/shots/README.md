# Landing page screenshots

Seven images, all taken. They are generated rather than hand-captured, from a
seeded set of accounts and a Playwright script, so re-taking them after a UI
change is two commands rather than an afternoon.

## Re-taking them

With the dev servers running (`npm run dev` from the repo root):

```bash
npm run seed-showcase --workspace=server   # build the accounts and their content
npm run shots                              # capture all of them into this folder
npm run shots -- feeds notes               # or just the ones you need
npm run marketing:check                    # confirm the pages render them
```

`marketing:check` walks the landing page, all six feature pages and
/self-hosting **through the nav menu**, and fails on either of the two ways
these pages go wrong without erroring: a frame still showing its spec-sheet
placeholder (a shot wired up under the wrong filename looks exactly like one not
yet taken), and any reveal-on-scroll element left at `opacity: 0` (its copy is
in the DOM, passes every test, and is never seen). It navigates rather than
loading URLs directly because the second failure only ever happened on the
navigation path.

Re-seed immediately before capturing. The unread state the hero and feeds shots
rely on is perishable — the background feed scheduler keeps pulling in new
items, and every one of those arrives unread.

The accounts are `maren` (the one almost every shot is taken from) plus
`theovance`, `irisbello` and `sanakaur`. The password is at the top of
`server/scripts/seedShowcase.ts`, and the script prints it when it finishes.

Sizes and the "must show" list live in `SECTIONS[].shot` and `HERO_SHOT` in
`client/src/marketing/sections.ts` — that is the copy the page renders when a
shot is missing, so it is the spec. `scripts/shots.mjs` mirrors the sizes.

## If `blog.png` comes back badly framed

That shot has to fit four things into 900px — cover, byline, reference card and
the top of the thread — and the reference card's height follows the artwork of
whichever real article the seed happened to pick, which swings by 100px or more
between runs. Two levers, in `scripts/shots.mjs` and `seedShowcase.ts`:

- the scroll offset on the `Comments` heading (raise it to show more cover,
  lower it to show more thread);
- the embed variant in `seedShowcase.ts` — `'small'` instead of `'large'` makes
  the card ~90px rather than ~330px and buys back the whole cover, at the cost
  of a less striking card.

## Two things worth knowing

**`social.png` cannot satisfy its whole spec.** It asks for the Friends tab and
an un-followed Follow button in one frame. `ProfilePage` renders the Friends tab
only when `profile.isSelf` and the Follow button only when it isn't, so the two
are mutually exclusive states of one page. The shot in use is Theo's view of
Maren — avatar, posts, Follow un-followed. `social-friends.png` is the other
reading (Maren's own profile, Friends tab) if you would rather lead with that.
The nested comment thread the spec also mentions is carried by `blog.png`.

**The notes console is maximised in `notes.png`.** At its default height the
console body is about 480px and the slash menu alone is about 430px of that, so
the menu covered the entire note it was meant to be demonstrating. Maximising is
what lets the heading, the to-dos, the reference card and the open menu all be
visible at once. The console's own surface is light by design (see
`NotesConsole.module.css`) — that is not a theme bug in the capture.

## If you take one by hand instead

- **Dark theme** unless a shot is specifically showing off the light one.
- **Capture at 2×** — the script uses `deviceScaleFactor: 2`, so a 1200 × 800
  shot is a 2400 × 1600 file.
- **Real content, not lorem.** Everything feed-shaped in the seed is selected
  from articles actually fetched into the database, never written, so no
  invented headline can reach a published screenshot.
- **Scrub anything private.** The seeded cast is fictional and its only email
  addresses are `@example.com`.
- Crop to the app. The page draws its own browser chrome around each shot.
