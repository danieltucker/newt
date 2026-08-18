import { describe, it, expect } from 'vitest';
import {
  isSettingsPath, parseSettingsSection, settingsPathFor, SETTINGS_SECTIONS,
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
  it('reads every section the rail offers', () => {
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
    // Deliberately not an error: settings still open, on the list or the first
    // section, rather than the visitor getting a 404 for a typo.
    expect(parseSettingsSection('/settings/nonsense')).toBeNull();
    expect(parseSettingsSection('/settings/account/extra')).toBeNull();
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
