-- Which of the reader's own articles an answer was given.
--
-- The list was streamed to the browser and then dropped: it lived in the
-- component state that held the in-flight turn, so it vanished the moment the
-- answer finished and was gone entirely on reload. That made the citations
-- unverifiable in exactly the case that matters — coming back to a thread later
-- and asking "where did that come from?".
--
-- Re-running the search to rebuild the list is not an option and never was. The
-- search is over a river that moves: the same question next month ranks
-- different articles, and some of what was read has since aged out of the feed
-- entirely. The only honest record is the one captured at the time.
--
-- JSON rather than a join table, matching `suggestions` directly above it: a
-- short ordered list, written once with the message and only ever read whole.
-- A relation to FeedItem would have been worse than useless here, because those
-- rows are deleted as they age out and the citation would go with them.
ALTER TABLE "ResearchMessage"
  ADD COLUMN "sources" JSONB NOT NULL DEFAULT '[]';
