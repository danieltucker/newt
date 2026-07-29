// Where the source lives. One constant because the repository has been renamed
// once already (newTab → newt) and the old name outlived the rename in three
// separate files - a footer link, a marketing page's button and the clone line
// in its terminal mock. Anything that names the repo imports from here.
export const REPO_URL = 'https://github.com/danieltucker/newt';

// The repository's own name, for prose and for the `git clone` / `cd` lines on
// the self-hosting page. Derived rather than typed again, so a future rename is
// still a one-line change.
export const REPO_NAME = REPO_URL.slice(REPO_URL.lastIndexOf('/') + 1);
