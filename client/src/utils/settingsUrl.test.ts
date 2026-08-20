import { describe, it, expect } from 'vitest';
import {
  isSettingsPath, parseSettingsSection, settingsPathFor, SETTINGS_SECTIONS,
  SETTINGS_GROUPS, groupForSection, sectionsInGroup,
} from './settingsUrl';

describe('isSettingsPath', () => {
  it('matches the index and a section', () => {
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/')).toBe(true);
    expect(isSettingsPath('/settings/reading')).toBe(true);
  });

  it('does not match a neighbouring path', () => {
    // The prefix test must not claim a route that merely starts the same way.
    expect(isSettingsPath('/settingsx')).toBe(false);
    expect(isSettingsPath('/')).toBe(false);
    expect(isSettingsPath('/blog')).toBe(false);
  });
});

describe('parseSettingsSection', () => {
  it('reads every section the nav offers', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseSettingsSection(`/settings/${section}`)).toBe(section);
    }
  });

  it('tolerates a trailing slash and odd casing', () => {
    expect(parseSettingsSection('/settings/ai/')).toBe('ai');
    expect(parseSettingsSection('/settings/Appearance')).toBe('appearance');
  });

  it('returns null for the bare index', () => {
    expect(parseSettingsSection('/settings')).toBeNull();
    expect(parseSettingsSection('/settings/')).toBeNull();
  });

  it('returns null for a name nothing answers to', () => {
    // Deliberately not an error: settings still open, on the first section,
    // rather than the visitor getting a 404 for a typo.
    expect(parseSettingsSection('/settings/nonsense')).toBeNull();
    expect(parseSettingsSection('/settings/account/extra')).toBeNull();
  });

  it('sends a retired section name to where its settings went', () => {
    // A name that used to be real is not a typo: it had blocks under it, they
    // are still somewhere, and the anchors came along - so this has to resolve
    // rather than fall through to the null above.
    expect(parseSettingsSection('/settings/integrations')).toBe('advanced');
    expect(parseSettingsSection('/settings/Integrations/')).toBe('advanced');
  });
});

describe('SETTINGS_GROUPS', () => {
  it('files every section in exactly one group', () => {
    const filed = SETTINGS_GROUPS.flatMap(g => [...g.sections]);
    expect([...filed].sort()).toEqual([...SETTINGS_SECTIONS].sort());
    expect(new Set(filed).size).toBe(filed.length);
  });

  it('derives the group from the section', () => {
    expect(groupForSection('account')).toBe('account');
    expect(groupForSection('appearance')).toBe('newtab');
    expect(groupForSection('search')).toBe('newtab');
    expect(groupForSection('reading')).toBe('reading');
    expect(groupForSection('ai')).toBe('ai');
    expect(groupForSection('advanced')).toBe('advanced');
  });

  it('keeps the group out of the address', () => {
    // The whole point of deriving it: every URL that worked before still works.
    for (const section of SETTINGS_SECTIONS) {
      expect(settingsPathFor(section)).toBe(`/settings/${section}`);
    }
  });

  it('lands a group on its first section', () => {
    for (const g of SETTINGS_GROUPS) {
      expect(sectionsInGroup(g.id)[0]).toBe(g.sections[0]);
      expect(groupForSection(g.sections[0])).toBe(g.id);
    }
  });
});

describe('settingsPathFor', () => {
  it('addresses the index, a section and one setting', () => {
    expect(settingsPathFor()).toBe('/settings');
    expect(settingsPathFor(null)).toBe('/settings');
    expect(settingsPathFor('reading')).toBe('/settings/reading');
    expect(settingsPathFor('reading', 'comments-sort')).toBe('/settings/reading#comments-sort');
  });

  it('round-trips through the parser', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseSettingsSection(settingsPathFor(section))).toBe(section);
    }
  });
});
