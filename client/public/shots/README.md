# Landing page screenshots

Seven images, all still to take. Until a file lands here the landing page draws
a frame in its place listing what the shot needs, so nothing is silently
missing - the gap is visible on the page itself.

## How to add one

1. Take the shot, save it here under the filename below.
2. Open `client/src/pages/LandingPage.tsx`, find the entry in `SHOTS`, and add
   `src: '/shots/<file>.png'`.

That's the whole change. The frame swaps from the spec sheet to the image.

## Taking them

- **Dark theme** unless a shot is specifically showing off the light one. The
  page's own surfaces are dark, so a light screenshot sits in it like a hole.
- **Capture at 2×** and save at the listed size - the frames are up to ~700px
  wide on a desktop screen and will be viewed on retina displays.
- **Real content, not lorem.** Actual headlines, actual site names. The one
  thing that makes a product page look fake is placeholder text inside the
  screenshot.
- **Scrub anything private** - real usernames, real email addresses, anything
  in a note you wouldn't put on a billboard.
- Crop to the app, not the whole desktop. The page draws its own browser chrome
  around each shot, so a second window frame inside it reads as a mistake.

## The list

| File | Size | Must show |
|---|---|---|
| `hero.png` | 1600 × 1000 | The whole new tab: a full folder of bookmarks, sidebar open, 3–4 reading-list cards with artwork, an RSS folder with a couple of unread dots, search bar empty. |
| `bookmarks.png` | 1200 × 800 | Four or five colour-coded folders in the sidebar, a tile mid-drag with the drop gap open, the pinned row across the top. |
| `feeds.png` | 1200 × 800 | A folder's article list with real headlines, at least two unread indicators, one favourited tag chip so the gold is visible. |
| `reading.png` | 1200 × 900 | Magazine layout - one feature card plus standards, tags on at least one card, read-time estimates showing. |
| `notes.png` | 1400 × 900 | Console open over the dimmed page, slash menu open mid-list, a note with a heading, a to-do or two and a reference card. |
| `blog.png` | 1200 × 900 | A real post with a hero image and byline, a reference card in the body, the comment thread started underneath. |
| `social.png` | 1200 × 800 | A profile with avatar, a few posts and the Friends tab; the Follow button un-followed; a comment thread two or three replies deep. |

The same table lives in `SHOTS` in `LandingPage.tsx` - that is the copy the page
renders, so keep them in step or just read it there.
