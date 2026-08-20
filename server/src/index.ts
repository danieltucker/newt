import 'dotenv/config';
import app from './app';
import logger from './lib/logger';
import { startFeedScheduler, stopFeedScheduler } from './lib/feedScheduler';
import { backfillExploredPaths } from './lib/exploredPaths';
import { backfillArticleArchive } from './lib/archiveBackfill';

// Process entry point. Everything that binds a port, opens a timer or installs a
// signal handler belongs here; the app itself is assembled in app.ts so tests can
// mount it without any of this running.

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
  // Background feed refresher — keeps demanded feeds fresh without tying the
  // work to any user request. Disable with FEED_SCHEDULER=false (e.g. when
  // running multiple instances and only one should poll).
  if (process.env.FEED_SCHEDULER !== 'false') startFeedScheduler();
  // Fill in the two derived columns that explored paths reads, for rows written
  // before they existed. Both are computed by TypeScript the migration cannot
  // call (see exploredPaths.ts); neither blocks the server from serving, and a
  // failure only means some article pages list less than they could.
  void backfillExploredPaths();
  // Same deal for the article archive: fill in ReadingListItem.articleKey for
  // rows that predate the column, and — on the first boot after the archive
  // ships — seed it from the feed items still in the river, which is the one
  // chance to keep that window before it expires. Both are no-ops once done,
  // and neither blocks the server from serving (see archiveBackfill.ts).
  void backfillArticleArchive();
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully');
  stopFeedScheduler();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Force-exit if connections don't drain within 10s
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
