import { CommentVisibility } from '../types';

// The three visibility tiers and how they are labelled, shared by everything
// that lets you choose one - the comment composer and the blog post composer.
// Both write to the same `visibility` vocabulary and are read through the same
// friendship rules, so the wording must not drift between them.
//
// On a blog post the tiers mean the same thing, with one addition worth stating
// in the UI: 'private' is also the draft state, since a post only you can see is
// exactly an unpublished one.

export const VIS_ORDER: CommentVisibility[] = ['public', 'friends', 'private'];

export interface VisMeta {
  label: string;
  tag: string;
  hint: string;
  icon: JSX.Element;
}

export const VIS_META: Record<CommentVisibility, VisMeta> = {
  public:  { label: 'Public',        tag: 'Public',        hint: 'Anyone using this app can read this comment',        icon: <GlobeIcon /> },
  friends: { label: 'Friends',       tag: 'Friends',       hint: 'Only your accepted friends can read this comment',    icon: <FriendsIcon /> },
  private: { label: 'Personal Note', tag: 'Personal Note', hint: 'Only you can read this - a private note to yourself', icon: <LockIcon /> },
};

// Blog posts reuse the same tiers but read differently: they're published
// writing, not notes, and 'private' is how a draft is expressed.
export const POST_VIS_META: Record<CommentVisibility, VisMeta> = {
  public:  { label: 'Public',  tag: 'Public',  hint: 'Anyone can read this post, including people who aren’t signed in', icon: <GlobeIcon /> },
  friends: { label: 'Friends', tag: 'Friends', hint: 'Only your accepted friends can read this post',                    icon: <FriendsIcon /> },
  private: { label: 'Draft',   tag: 'Draft',   hint: 'Only you can read this - an unpublished draft',                    icon: <LockIcon /> },
};

export function GlobeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function FriendsIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
