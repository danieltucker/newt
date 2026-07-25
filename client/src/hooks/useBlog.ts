import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../services/api';
import { BlogPost, BlogPostSummary, CommentVisibility } from '../types';

// Your own posts, for the manage list. Drafts (private posts) are included —
// this is the author's view, not the public one.
export function useMyPosts(accessToken: string | null) {
  const [posts, setPosts] = useState<BlogPostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // `alive` lets the mount effect drop a response that lands after unmount,
  // while an explicit reload() (which has no unmount to race) passes nothing.
  const fetchPosts = useCallback((alive?: () => boolean) => {
    const ok = () => (alive ? alive() : true);
    setLoading(true);
    return apiGet<{ posts: BlogPostSummary[] }>('/api/v1/blogs/mine')
      .then(d => { if (ok()) { setPosts(d.posts); setError(''); } })
      .catch(() => { if (ok()) setError('Couldn’t load your posts'); })
      .finally(() => { if (ok()) setLoading(false); });
  }, []);

  const reload = useCallback(() => fetchPosts(), [fetchPosts]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchPosts(() => !cancelled);
    return () => { cancelled = true; };
  }, [accessToken, fetchPosts]);

  const remove = useCallback(async (id: string) => {
    await apiDelete(`/api/v1/blogs/post/${encodeURIComponent(id)}`);
    setPosts(prev => prev.filter(p => p.id !== id));
  }, []);

  return { posts, loading, error, reload, remove };
}

export interface PostDraft {
  title: string;
  body: string;
  visibility: CommentVisibility;
  commentsEnabled: boolean;
}

export function createPost(draft: PostDraft): Promise<BlogPost> {
  return apiPost<BlogPost>('/api/v1/blogs', draft);
}

export function updatePost(id: string, patch: Partial<PostDraft>): Promise<BlogPost> {
  return apiPatch<BlogPost>(`/api/v1/blogs/post/${encodeURIComponent(id)}`, patch);
}

export function loadOwnPost(id: string): Promise<BlogPost> {
  return apiGet<BlogPost>(`/api/v1/blogs/post/${encodeURIComponent(id)}`);
}
