import { describe, it, expect } from 'vitest';
import {
  isAdminPath, parseAdminTab, parseAdminReportId, adminPathFor, ADMIN_TABS,
  ADMIN_SECTIONS, sectionForTab, tabsInSection,
} from './adminUrl';

describe('isAdminPath', () => {
  it('matches the index and a tab', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/')).toBe(true);
    expect(isAdminPath('/admin/users')).toBe(true);
    expect(isAdminPath('/admin/reports/abc')).toBe(true);
  });

  it('does not match a neighbouring path', () => {
    expect(isAdminPath('/administration')).toBe(false);
    expect(isAdminPath('/')).toBe(false);
    expect(isAdminPath('/blog')).toBe(false);
  });
});

describe('parseAdminTab', () => {
  it('reads every tab the nav offers', () => {
    for (const tab of ADMIN_TABS) {
      expect(parseAdminTab(`/admin/${tab}`)).toBe(tab);
    }
  });

  it('tolerates a trailing slash and odd casing', () => {
    expect(parseAdminTab('/admin/ai/')).toBe('ai');
    expect(parseAdminTab('/admin/Users')).toBe('users');
  });

  it('resolves a single report to the Reports tab', () => {
    // The id is a view of that tab, not a tab of its own.
    expect(parseAdminTab('/admin/reports/abc123')).toBe('reports');
  });

  it('returns null for the bare index', () => {
    expect(parseAdminTab('/admin')).toBeNull();
    expect(parseAdminTab('/admin/')).toBeNull();
  });

  it('returns null for a name nothing answers to', () => {
    expect(parseAdminTab('/admin/nonsense')).toBeNull();
    expect(parseAdminTab('/admin/users/1/extra')).toBeNull();
  });

  it('has no personas tab - it was renamed', () => {
    expect(parseAdminTab('/admin/personas')).toBeNull();
    expect(ADMIN_TABS).toContain('ai');
    expect(ADMIN_TABS).not.toContain('personas');
  });
});

describe('parseAdminReportId', () => {
  it('reads the id under reports', () => {
    expect(parseAdminReportId('/admin/reports/abc123')).toBe('abc123');
    expect(parseAdminReportId('/admin/reports/abc123/')).toBe('abc123');
  });

  it('is null for the queue itself', () => {
    expect(parseAdminReportId('/admin/reports')).toBeNull();
  });

  it('does not invent ids under other tabs', () => {
    // /admin/users/<id> is not a route the console serves.
    expect(parseAdminReportId('/admin/users/abc123')).toBeNull();
    expect(parseAdminReportId('/admin/ai/abc123')).toBeNull();
  });

  it('decodes what adminPathFor encoded', () => {
    const id = 'a/b c';
    expect(parseAdminReportId(adminPathFor(null, id))).toBe(id);
  });
});

describe('adminPathFor', () => {
  it('addresses the index, a tab and one report', () => {
    expect(adminPathFor()).toBe('/admin');
    expect(adminPathFor(null)).toBe('/admin');
    expect(adminPathFor('ai')).toBe('/admin/ai');
    expect(adminPathFor(null, 'r1')).toBe('/admin/reports/r1');
  });

  it('round-trips through the parser', () => {
    for (const tab of ADMIN_TABS) {
      expect(parseAdminTab(adminPathFor(tab))).toBe(tab);
    }
  });
});

describe('sections', () => {
  it('files every view under exactly one section', () => {
    const filed = ADMIN_SECTIONS.flatMap(s => [...s.tabs]);
    expect([...filed].sort()).toEqual([...ADMIN_TABS].sort());
    expect(new Set(filed).size).toBe(filed.length);
  });

  it('derives the section from the view', () => {
    expect(sectionForTab('overview')).toBe('overview');
    expect(sectionForTab('reports')).toBe('moderation');
    expect(sectionForTab('blog')).toBe('moderation');
    expect(sectionForTab('feeds')).toBe('system');
    expect(sectionForTab('audit')).toBe('system');
    expect(sectionForTab('ai')).toBe('ai');
  });

  it('keeps the section out of the address', () => {
    // The whole point of deriving it: every URL that worked before still works,
    // including the report deep link the notification bell sends people to.
    for (const tab of ADMIN_TABS) {
      expect(adminPathFor(tab)).toBe(`/admin/${tab}`);
    }
    expect(adminPathFor(null, 'r1')).toBe('/admin/reports/r1');
    expect(parseAdminTab('/admin/reports/r1')).toBe('reports');
  });

  it('lands on a real view when a section is picked', () => {
    for (const sec of ADMIN_SECTIONS) {
      const first = sec.tabs[0];
      expect(ADMIN_TABS).toContain(first);
      // Picking the section and then reading the address back must agree about
      // which section you are in, or the lit pill would fight the URL.
      expect(sectionForTab(first)).toBe(sec.id);
    }
  });

  it('reports the views in a section, in sub-nav order', () => {
    expect(tabsInSection('moderation')).toEqual(['reports', 'users', 'comments', 'blog']);
    expect(tabsInSection('system')).toEqual(['feeds', 'errors', 'audit']);
    // Sections of one render no sub-nav at all; the length is what decides it.
    expect(tabsInSection('overview')).toHaveLength(1);
    expect(tabsInSection('ai')).toHaveLength(1);
  });

  it('starts the first section on the view a bare /admin resolves to', () => {
    expect(ADMIN_TABS[0]).toBe('overview');
    expect(ADMIN_SECTIONS[0].tabs[0]).toBe('overview');
  });
});
