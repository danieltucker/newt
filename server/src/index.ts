import 'dotenv/config';
import app from './app';
import logger from './lib/logger';
import { startFeedScheduler, stopFeedScheduler } from './lib/feedScheduler';

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
