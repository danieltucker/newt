import ArticleDetailModal from '../components/ArticleDetailModal';
import { CommentPrefs } from '../types';
import { profilePathFor } from '../utils/profileUrl';
import styles from './PublicArticlePage.module.css';

// Standalone, logged-out view of a shared thread link (/a/<id>). Reuses the
// article reader in read-only mode: a visitor can read the article and its
// public comments, but posting requires signing in. Signed-in users never land
// here — App routes them into the app shell, which opens the same reader over
// their tabs.

interface Props {
  url: string;
  navigate: (to: string) => void;
}

// Anonymous defaults: show public comments, newest first. There's no account to
// carry a saved preference, and the default-visibility only matters for posting.
const ANON_PREFS: CommentPrefs = {
  showPublic: true,
  defaultVisibility: 'public',
  sort: 'newest',
  autoExpand: true,
};

export default function PublicArticlePage({ url, navigate }: Props) {
  return (
    <div className={styles.page}>
      <ArticleDetailModal
        url={url}
        title=""
        prefs={ANON_PREFS}
        readOnly
        onViewProfile={name => navigate(profilePathFor(name))}
        onClose={() => navigate('/')}
        actions={
          <button className={styles.signInBtn} onClick={() => navigate('/')}>
            Sign in
          </button>
        }
      />
    </div>
  );
}
