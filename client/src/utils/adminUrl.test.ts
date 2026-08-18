import { describe, it, expect } from 'vitest';
import {
  isAdminPath, parseAdminTab, parseAdminReportId, adminPathFor, ADMIN_TABS,
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
