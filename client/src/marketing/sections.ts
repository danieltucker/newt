// The six things Newt is, written once and used everywhere: the nav menu, the
// landing page's feature stripes, the cross-link strips, and a full page each.
//
// Every section carries a `tint`. It is not decoration - it is how a visitor
// knows which of the six they are reading without checking the heading: the
// kicker, the glow behind the screenshot, the nav dot, the tick marks and the
// band washes on that section's page all come from this one colour.

export interface ShotSpec {
  id: string;
  /** What to name the file, and what the frame calls itself while empty. */
  title: string;
  /** Pixel size to capture at - 2x these for a retina asset. */
  size: string;
  /** Everything that must be on screen for the shot to make its point. */
  capture: string[];
  /** Set to '/shots/<file>.png' once taken. */
  src?: string;
}

/** One step in the three-beat "how it goes" strip on a section page. */
export interface Step {
  title: string;
  body: string;
}

/** A situation, told as a person rather than as a feature list. */
export interface UseCase {
  /** Who this is - a role or a habit, not a name. */
  who: string;
  /** The problem, in their words. */
  problem: string;
  /** What they do in Newt instead. */
  answer: string;
}

export interface Section {
  /** URL segment: /features/<slug> */
  slug: string;
  /** Label in the nav menu and cross-link strips. */
  nav: string;
  /** The uppercase mono kicker above every heading on the section. */
  kicker: string;
  /** Hex, not a token: these are fixed brand colours in both themes. */
  tint: string;
  /** One line, for the nav menu and the cross-link cards. */
  blurb: string;

  /** The landing page's stripe. */
  landing: {
    title: string;
    body: string;
    points: string[];
    /** Screenshot on the left instead of the right. */
    flip?: boolean;
  };

  /** The section's own page. */
  page: {
    title: string;
    lede: string;
    /** Pulled out large on a dark band - the one sentence to remember. */
    statement: string;
    steps: Step[];
    useCases: UseCase[];
    details: { title: string; body: string }[];
  };

  shot: ShotSpec;
}

export const SECTIONS: Section[] = [
  // ── Bookmarks ───────────────────────────────────────────────────────
  {
    slug: 'bookmarks',
    nav: 'Bookmarks',
    kicker: 'Bookmarks',
    tint: '#9B8CFF',
    blurb: 'The sites you actually open, where you can see them.',
    landing: {
      title: 'A desk, not a drawer',
      body:
        'Colour-coded folders you can actually tell apart, drag-and-drop that goes where you ' +
        'aimed it, and a pinned row for the eight or nine sites you open without thinking. ' +
        'Already have a tangle? Import your browser’s bookmarks file and sort it out here.',
      points: ['Colour-coded folders', 'Pin to the top row', 'Import from any browser', 'Panel or inline layout'],
    },
    page: {
      title: 'The sites you actually open, in front of you',
      lede:
        'Browser bookmarks are a filing cabinet: everything goes in, nothing comes out, and ' +
        'the good stuff is four folders deep behind a chevron. Newt turns the same list into ' +
        'a surface - one you look at a hundred times a day, laid out so the sites you care ' +
        'about are the ones you can see.',
      statement:
        'A hundred tabs a day open on a blank page. This is the argument for putting your own ' +
        'shortlist there instead.',
      steps: [
        {
          title: 'Bring what you already have',
          body:
            'Export the bookmarks file every browser knows how to write, drop it on the import ' +
            'window, and the whole tree arrives - folders, names, favicons and all.',
        },
        {
          title: 'Give the folders colours',
          body:
            'Twelve of them, assigned per folder. Colour is faster to read than a label, and ' +
            'after a week you stop reading the names entirely.',
        },
        {
          title: 'Pin the ones you never think about',
          body:
            'The handful you type from muscle memory go in a grid across the top of the ' +
            'sidebar. Pinning is a view flag, not a move - a pinned site still lives in its ' +
            'folder too.',
        },
      ],
      useCases: [
        {
          who: 'The person with the morning six',
          problem:
            'Same six sites, every morning, typed out letter by letter because the bookmarks ' +
            'bar ran out of room two years ago.',
          answer:
            'They live in the pinned grid. One tab, six targets, no typing - and the tiles show ' +
            'you which of them has published something since you last looked.',
        },
        {
          who: 'Someone with a work self and a home self',
          problem:
            'Work links, hobby links and the shop you keep meaning to order from all sat in one ' +
            'undifferentiated list.',
          answer:
            'A folder each, in three colours you can tell apart at a glance. Switch folders and ' +
            'the grid switches with you - the other two are still one click away, not in your face.',
        },
        {
          who: 'Anyone mid-project',
          problem:
            'Twenty tabs open because closing one means losing it, and the project ends in three ' +
            'weeks anyway.',
          answer:
            'A folder for the project, filled in a single drag apiece. When it ends, the folder ' +
            'goes, and your browser gets its memory back.',
        },
      ],
      details: [
        {
          title: 'Drag and drop that lands',
          body: 'Tiles reorder within a folder and move between folders, with the gap opening where the tile will go.',
        },
        {
          title: 'Panel or inline',
          body:
            'Panel keeps folders in the sidebar and their contents in a grid to the right. ' +
            'Inline expands folders in place, several at once, if you would rather see everything.',
        },
        {
          title: 'Names you chose',
          body: 'Newt guesses a display name from the domain when you add a link; you get the final say before it saves.',
        },
        {
          title: 'Found by search first',
          body: 'The search bar looks through your own bookmarks before it offers to send the words to a search engine.',
        },
      ],
    },
    shot: {
      id: 'bookmarks',
      title: 'Bookmarks and folders',
      size: '1200 × 800',
      capture: [
        'Four or five colour-coded folders in the sidebar',
        'A tile mid-drag, with the drop gap open',
        'The pinned row across the top of the sidebar',
      ],
      src: '/shots/bookmarks.png',
    },
  },

  // ── Feeds ───────────────────────────────────────────────────────────
  {
    slug: 'feeds',
    nav: 'Feeds',
    kicker: 'Feeds',
    tint: '#5BC8E6',
    blurb: 'Your bookmarks tell you when they’ve published.',
    landing: {
      title: 'It goes and finds the RSS for you',
      body:
        'Bookmark a site and Newt quietly checks whether it publishes a feed. If it does, new ' +
        'posts light up on the tile, and the whole folder’s worth of articles is one click ' +
        'away. No feed reader to keep in sync, no separate app to remember.',
      points: ['Auto-discovered feeds', 'Unread indicators', 'Read by folder', 'Star a tag to flag matches'],
      flip: true,
    },
    page: {
      title: 'Your bookmarks already know when there’s something new',
      lede:
        'The sites you like still publish. They just have no way to tell you, because the ' +
        'timeline that used to carry them now decides who sees what. Newt goes back to the ' +
        'plumbing: you say which sites matter, and each one gets to tell you when it has ' +
        'posted - in the order it posted, not in the order anything ranked it.',
      statement:
        'A feed you assembled by hand, in the order it happened. No ranking, no suggestions, ' +
        'nothing you didn’t ask for.',
      steps: [
        {
          title: 'You bookmark a site',
          body:
            'That’s the whole subscribe step. Nothing to paste, no feed URL to hunt for in a ' +
            'page footer.',
        },
        {
          title: 'Newt goes looking for the feed',
          body:
            'It reads the page for a declared RSS or Atom feed, then tries the usual paths if ' +
            'there isn’t one. Most sites have one. Plenty of people running them don’t know.',
        },
        {
          title: 'The tile lights up',
          body:
            'New posts since your last visit put a mark on the tile. Open the folder to read ' +
            'the headlines from every site in it, together.',
        },
      ],
      useCases: [
        {
          who: 'Anyone who follows small sites',
          problem:
            'The blogs and independents worth reading post twice a month, have no newsletter, ' +
            'and vanish from every feed that ranks by engagement.',
          answer:
            'Two posts a month is two marks on a tile. Nothing has to be popular to reach you - ' +
            'it only has to be something you chose.',
        },
        {
          who: 'Someone following a beat',
          problem:
            'Six outlets cover the thing they care about, and checking all six daily is a chore ' +
            'nobody keeps up for long.',
          answer:
            'One category, six sites, one list of headlines in date order. Star the tags you’re ' +
            'watching and matching stories flag themselves.',
        },
        {
          who: 'The lapsed feed-reader user',
          problem:
            'They loved RSS, then stopped opening the app, and now there are 4,000 unread items ' +
            'in a tab they never visit.',
          answer:
            'There is no app to open. The feeds sit on the page the browser already puts in ' +
            'front of you, and the count only ever covers sites you chose to follow.',
        },
      ],
      details: [
        {
          title: 'Discovery, not configuration',
          body: 'Declared feed links first, common paths second. If a site has no feed, the bookmark simply stays a bookmark.',
        },
        {
          title: 'Unread, per site',
          body: 'A mark appears when the newest post is newer than your last visit, and clears when you go.',
        },
        {
          title: 'One feed, filed how you like',
          body: 'Everything you follow in one river, newest first - narrowed to a category, a site or a topic when you want it.',
        },
        {
          title: 'Straight to the publisher',
          body:
            'Headlines open the site that wrote them. The point of the list is to get you there - ' +
            'the traffic goes where the work was done.',
        },
      ],
    },
    shot: {
      id: 'feeds',
      title: 'RSS, discovered for you',
      size: '1200 × 800',
      capture: [
        'The combined feed with real headlines from several sites',
        'At least two unread indicators',
        'A favourited tag chip, so the gold is visible',
      ],
      src: '/shots/feeds.png',
    },
  },

  // ── Reading list ────────────────────────────────────────────────────
  {
    slug: 'reading',
    nav: 'Reading list',
    kicker: 'Reading list',
    tint: '#F2A65A',
    blurb: 'Saved for later, and actually findable later.',
    landing: {
      title: 'The articles you meant to get to',
      body:
        'Save anything with a tag, a note to yourself, and an honest read-time estimate - so ' +
        '"I’ll read this later" becomes a plan rather than a lie. Lays out as a magazine, ' +
        'as cards, or as a plain list, depending on how much you want to be tempted.',
      points: ['Tags and personal notes', 'Read-time estimates', 'Magazine / cards / list', 'Keep it in the Library'],
    },
    page: {
      title: '“I’ll read this later” - and this time you do',
      lede:
        'Everything you saved this year is technically still saved. It is also unsorted, ' +
        'untitled and unfindable, which is the same as gone. Newt gives the pile a shape: a ' +
        'tag, a line of your own about why you kept it, and an honest estimate of what it will ' +
        'cost you to actually read it.',
      statement:
        'Saving something is a promise to yourself. This is the part of Newt that helps you keep it.',
      steps: [
        {
          title: 'Save it with a reason',
          body:
            'A tag and a note, written in the two seconds while you still remember why you ' +
            'wanted it. That note is what makes the article findable in March.',
        },
        {
          title: 'Read it when there’s time',
          body:
            'Every card carries a read-time estimate, so a ten-minute gap has ten-minute ' +
            'options and you stop opening the 45-minute piece by accident.',
        },
        {
          title: 'Shelve what you want to keep',
          body:
            'Finished articles worth keeping go to the Library, sorted into folders of your ' +
            'own. Folders contain; tags describe. Both, because they do different jobs.',
        },
      ],
      useCases: [
        {
          who: 'The lunchtime saver',
          problem:
            'Long pieces get found on a phone at the worst possible moment and are never seen ' +
            'again.',
          answer:
            'Newt is a website, so it’s the same list on the phone and on the desk. Save it at ' +
            'lunch, and it’s waiting on the new tab that evening.',
        },
        {
          who: 'Someone researching something',
          problem:
            'Thirty sources for one piece of work, in a bookmark folder with no notes, so every ' +
            'one has to be reopened to remember what it was for.',
          answer:
            'A Library folder for the project, a tag for the sub-topic, and your own note on each ' +
            'one saying what it proves. The folder becomes the bibliography.',
        },
        {
          who: 'The person with 300 open tabs',
          problem:
            'Tabs are the reading list, the laptop fan knows it, and closing one still feels ' +
            'like deleting it.',
          answer:
            'Save the tab, close the tab. It’s on the new tab page now, with a note about why - ' +
            'which is more than the tab was telling you.',
        },
      ],
      details: [
        {
          title: 'Three layouts',
          body:
            'Magazine leads with one big card and artwork. Cards is even-handed. List is a ' +
            'plain queue for when you want to work through it rather than browse it.',
        },
        {
          title: 'Tags cut across',
          body: 'One item, one folder, as many tags as it earns. Tags are how you find the thread that runs through several folders.',
        },
        {
          title: 'The Library is yours alone',
          body: 'It is never fetched for another visitor and has no visibility setting to get wrong. Its absence is the guarantee.',
        },
        {
          title: 'Unsorted is a real place',
          body: 'An item with no folder isn’t broken - it’s unsorted, it says so, and deleting a folder drops its articles there rather than deleting them.',
        },
      ],
    },
    shot: {
      id: 'reading',
      title: 'The reading list',
      size: '1200 × 900',
      capture: [
        'Magazine layout - one feature card plus standards',
        'Tags visible on at least one card',
        'The read-time estimates showing',
      ],
      src: '/shots/reading.png',
    },
  },

  // ── Notes ───────────────────────────────────────────────────────────
  {
    slug: 'notes',
    nav: 'Notes',
    kicker: 'Notes',
    tint: '#36D6A6',
    blurb: 'A writing surface hiding behind the new tab.',
    landing: {
      title: 'Type / and keep going',
      body:
        'A proper writing surface hiding behind your new tab: folders, headings, to-dos, tables, ' +
        'code blocks, images you can paste straight in. Reference a saved article and it embeds ' +
        'as a card. Delete something and it waits fifteen days before it means it.',
      points: ['Slash commands', 'Folders and search', 'To-dos, tables, code, images', 'Recently deleted'],
      flip: true,
    },
    page: {
      title: 'The nearest place to write something down',
      lede:
        'Most notes die in the gap between having a thought and finding somewhere to put it. ' +
        'Newt closes the gap: the writing surface is behind the page your browser already ' +
        'opens, one keystroke away, with folders and search for when the note turns out to ' +
        'have been worth keeping.',
      statement:
        'The best place to write something down is the page that was already open.',
      steps: [
        {
          title: 'Open it from wherever you are',
          body: 'The notes console comes down over the page. Nothing loads, nothing navigates, and what you were doing is still there behind it.',
        },
        {
          title: 'Type / for anything structural',
          body: 'Headings, to-do lists, tables, code blocks, dividers, images pasted straight from the clipboard. The menu filters as you type.',
        },
        {
          title: 'Reference what you’ve saved',
          body: 'Point a note at an article from your reading list and it embeds as a card - title, source and link - rather than a bare URL you’ll have to decode later.',
        },
      ],
      useCases: [
        {
          who: 'Someone keeping a work log',
          problem:
            'What happened this week is spread over a chat app, a ticket tracker and memory, ' +
            'and the memory part is not going well.',
          answer:
            'A note per week, in a folder for the year. To-dos for what’s open, headings for ' +
            'what shipped, and it’s all searchable when the review comes round.',
        },
        {
          who: 'A writer with a half-idea',
          problem:
            'The idea arrives mid-browse, and by the time a document is open it has gone.',
          answer:
            'One keystroke, a heading, three lines. Later, one button turns it into a post ' +
            'without leaving Newt - the reference cards come with it, and the note stays put.',
        },
        {
          who: 'The reluctant deleter',
          problem:
            'Deleting a note requires certainty they do not have, so nothing is ever deleted ' +
            'and the list is unusable.',
          answer:
            'Deleted notes sit in Recently Deleted for fifteen days. Delete freely; the safety ' +
            'net is the point.',
        },
      ],
      details: [
        {
          title: 'Folders and search',
          body: 'Folders for the notes you keep, search for the ones you forgot you kept.',
        },
        {
          title: 'Real blocks',
          body: 'To-dos that tick, tables you can fill in, code blocks that keep their whitespace, images pasted inline.',
        },
        {
          title: 'Find and replace',
          body: 'For when a name changed halfway through, or the note is longer than you meant it to be.',
        },
        {
          title: 'Fifteen days of grace',
          body: 'Recently Deleted keeps what you removed, and empties itself so you never have to.',
        },
      ],
    },
    shot: {
      id: 'notes',
      title: 'The notes console',
      size: '1400 × 900',
      capture: [
        'Console open over the dimmed new tab page',
        'The slash command menu open, mid-list',
        'A note with a heading, a to-do or two, and a reference card',
      ],
      src: '/shots/notes.png',
    },
  },

  // ── Posts ───────────────────────────────────────────────────────────
  // Called "Posts" throughout the app, and here. The word "blog" still earns its
  // place on this page and nowhere else: it is the fastest way to tell a visitor
  // what they are looking at, and what they get is a blog in every respect that
  // matters - an address, an archive, followers, an RSS feed.
  //
  // The slug stays 'blog'. /features/blog is a public URL that has been linked
  // to; renaming it would break those links to buy nothing a visitor can see.
  {
    slug: 'blog',
    nav: 'Posts',
    kicker: 'Posting',
    tint: '#E88BC8',
    blurb: 'A place to publish that’s yours, at your own address.',
    landing: {
      title: 'Publish, or just think out loud',
      body:
        'Every account can post. It works the way a blog does - your own address, an archive, ' +
        'readers who follow you - and posts can be public, friends-only, or private, where ' +
        'private doubles as your drafts folder. Every post carries its own comment thread.',
      points: ['Public, friends-only, private', 'Drafts are just private posts', 'Cover images', 'Followers'],
    },
    page: {
      title: 'Everyone can post. Use it or don’t.',
      lede:
        'It’s a blog, in every way that matters: your own address, your own archive, and an RSS ' +
        'feed anyone can follow. We just call them posts. Writing in public has become a ' +
        'business decision - pick a platform, pick an audience strategy, post at the right hour. ' +
        'Newt’s version is smaller and older than that. You have an address, you write at it, ' +
        'and the people who wanted to read you can.',
      statement:
        'One writing surface, three audiences: everyone, your friends, or nobody but future you.',
      steps: [
        {
          title: 'Write it',
          body:
            'The same editor as your notes, given a cover image and a title. Start it as a note ' +
            'and finish it as a post if that’s how the thought arrives.',
        },
        {
          title: 'Choose who it’s for',
          body:
            'Public, friends-only, or private. Private is also where drafts live, so there is no ' +
            'second place to check for the half-finished ones.',
        },
        {
          title: 'It gets an address',
          body:
            'newt.page/u/you/the-post-title. Send that to anyone; it opens for them whether or ' +
            'not they have an account.',
        },
      ],
      useCases: [
        {
          who: 'The occasional essayist',
          problem:
            'Four posts a year doesn’t justify a static site generator, a domain, and an ' +
            'afternoon of fighting a build.',
          answer:
            'It’s already there, attached to the account. Write the post, make it public, send ' +
            'the link. Four times a year is a perfectly good rate.',
        },
        {
          who: 'Someone keeping a journal',
          problem:
            'They want to write regularly with no intention of anyone reading it, and every ' +
            'tool for this treats publishing as the goal.',
          answer:
            'Private posts. Same editor, same archive, same search - visible to nobody. If one ' +
            'of them turns out to be worth sharing, change one setting.',
        },
        {
          who: 'A person with a small circle',
          problem:
            'The update is for about nine people, and putting it on a public timeline for them ' +
            'means putting it in front of everyone else too.',
          answer:
            'Friends-only. The nine see it on their side of Newt; nobody else knows it exists.',
        },
      ],
      details: [
        {
          title: 'Drafts are private posts',
          body: 'One list, one editor, one place to look. Publishing is a change of visibility, not a migration.',
        },
        {
          title: 'Cover images',
          body: 'A post with artwork looks like something. It carries through to the card wherever the post is linked.',
        },
        {
          title: 'Followers',
          body: 'People can follow you and see new posts as they land, in the order you published them - by RSS, like any blog.',
        },
        {
          title: 'Comments underneath',
          body: 'Every post carries its own thread, with the same three visibility levels as the rest of Newt.',
        },
      ],
    },
    shot: {
      id: 'blog',
      title: 'A published post',
      size: '1200 × 900',
      capture: [
        'A real post with a hero image and a byline',
        'A reference card embedded in the body',
        'The comment thread started underneath',
      ],
      src: '/shots/blog.png',
    },
  },

  // ── Together ────────────────────────────────────────────────────────
  {
    slug: 'together',
    nav: 'Together',
    kicker: 'Together',
    tint: '#7FA8FF',
    blurb: 'Profiles, friends, and a thread on anything you read.',
    landing: {
      title: 'Talk about what you read',
      body:
        'Comment on any article, anywhere. Threads hang off the article’s own URL, so the ' +
        'conversation you started from an RSS card is the same one you find on the saved copy ' +
        'a month later. Say it publicly, to friends only, or to nobody but future you.',
      points: ['Threads on any URL', 'Three visibility levels', 'Friend requests', 'Block and report'],
      flip: true,
    },
    page: {
      title: 'The conversation lives with the article',
      lede:
        'The good discussion about a piece is somewhere else, on a site that gets the traffic ' +
        'and the writer doesn’t. Newt attaches the thread to the article’s own URL instead - so ' +
        'wherever you meet that link again, the conversation is already there.',
      statement:
        'A thread belongs to the thing it’s about, not to the platform that happened to host it.',
      steps: [
        {
          title: 'Comment from wherever you found it',
          body:
            'From an RSS headline, from a saved article, from a post. It’s the same thread ' +
            'either way, because the URL is what identifies it.',
        },
        {
          title: 'Pick who hears it',
          body:
            'Public, friends-only, or private. A private comment is a note to yourself stapled ' +
            'to the article, which is a surprisingly good way to read.',
        },
        {
          title: 'Find it again a month later',
          body:
            'Open the article from anywhere in Newt and the thread comes with it - yours and ' +
            'everyone else’s, in the order it was said.',
        },
      ],
      useCases: [
        {
          who: 'A few friends who read the same things',
          problem:
            'The link gets pasted into a group chat, gets six replies, and is unfindable by the ' +
            'following week.',
          answer:
            'Friends-only comments on the article itself. Next time any of you opens that link, ' +
            'the conversation is on it.',
        },
        {
          who: 'The margin-note reader',
          problem:
            'They argue with articles in their head and have nowhere to put it.',
          answer:
            'Private comments. Nobody sees them, they’re attached to the piece forever, and ' +
            'they’re there when you reread it.',
        },
        {
          who: 'Someone who wants a smaller internet',
          problem:
            'Public comment sections are a reason to close the tab.',
          answer:
            'You see your friends and the people you followed. Blocking is mutual and complete, ' +
            'and reports go to a human.',
        },
      ],
      details: [
        {
          title: 'Profiles',
          body: 'Your posts, your comments and your friends in one place, at an address you can hand to someone.',
        },
        {
          title: 'Friend requests',
          body: 'Two-way, so "friends-only" means a set of people you both agreed on.',
        },
        {
          title: 'Blocking is a wall',
          body: 'Not a mute. Blocked accounts and yours become invisible to one another in both directions.',
        },
        {
          title: 'Reporting goes somewhere',
          body: 'Reports land in a queue an administrator actually works through.',
        },
      ],
    },
    shot: {
      id: 'social',
      title: 'Profiles and friends',
      size: '1200 × 800',
      // The first two bullets cannot both be true of one frame: ProfilePage
      // renders the Friends tab only when `profile.isSelf`, and the Follow
      // button only when it isn't. The shot taken is somebody else's view of
      // Maren — avatar, posts, Follow un-followed — which is the outward-facing
      // half, and the half this section is arguing for. The nested thread is
      // carried by the blog shot above. `/shots/social-friends.png` is the
      // other reading (own profile, Friends tab) if you'd rather lead with it.
      capture: [
        'A profile with an avatar, a few posts and the Friends tab',
        'The Follow button in its un-followed state',
        'A comment thread with two or three replies nested',
      ],
      src: '/shots/social.png',
    },
  },
];

export const SECTION_BY_SLUG: Record<string, Section> =
  Object.fromEntries(SECTIONS.map(s => [s.slug, s]));

/** The whole app in one shot, for the top of the landing page. */
export const HERO_SHOT: ShotSpec = {
  id: 'hero',
  title: 'The whole new tab',
  size: '1600 × 1000',
  capture: [
    'Dark theme, a full folder of bookmarks, sidebar open',
    'Reading list showing 3–4 cards with artwork',
    'An RSS folder with a couple of unread dots',
    'Search bar empty - it is the first thing the eye lands on',
  ],
  src: '/shots/hero.png',
};
