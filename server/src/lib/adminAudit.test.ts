import { describe, it, expect, vi } from 'vitest';
import {
  ADMIN_ACTIONS, actionLabel, isDestructive, recordAdminAction,
} from './adminAudit';

describe('ADMIN_ACTIONS', () => {
  it('names every action as <target>.<verb>', () => {
    for (const action of Object.values(ADMIN_ACTIONS)) {
      expect(action).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });

  it('has no duplicate values — two verbs sharing a name would merge in the log', () => {
    const values = Object.values(ADMIN_ACTIONS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('actionLabel', () => {
  it('gives every known action a human label', () => {
    for (const action of Object.values(ADMIN_ACTIONS)) {
      const label = actionLabel(action);
      expect(label).not.toBe(action);        // actually translated
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('falls back to the raw action so old rows still render', () => {
    // A row written before a rename must not show up as a blank cell.
    expect(actionLabel('user.shadowban')).toBe('user.shadowban');
    expect(actionLabel('')).toBe('');
  });
});

describe('isDestructive', () => {
  it('flags the actions that destroy content irreversibly', () => {
    expect(isDestructive(ADMIN_ACTIONS.commentDelete)).toBe(true);
    expect(isDestructive(ADMIN_ACTIONS.userDelete)).toBe(true);
  });

  it('does not flag reversible ones', () => {
    for (const action of [
      ADMIN_ACTIONS.postUnpublish,   // author's draft survives
      ADMIN_ACTIONS.userBan,
      ADMIN_ACTIONS.userUnban,
      ADMIN_ACTIONS.userPromote,
      ADMIN_ACTIONS.userDemote,
    ]) {
      expect(isDestructive(action)).toBe(false);
    }
  });
});

describe('recordAdminAction', () => {
  it('writes the row through the client it is handed, not a module-level one', async () => {
    // The point of the parameter: callers pass a transaction client so the
    // audit row commits with the action it describes.
    const create = vi.fn().mockResolvedValue({});
    const tx = { adminAction: { create } } as never;

    await recordAdminAction(tx, {
      actorId: 'admin1',
      actorUsername: 'sam',
      action: ADMIN_ACTIONS.userBan,
      targetType: 'user',
      targetId: 'user9',
      targetLabel: '@troublemaker',
      metadata: { sessionsRevoked: 3 },
    });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toEqual({
      data: {
        actorId: 'admin1',
        actorUsername: 'sam',
        action: 'user.ban',
        targetType: 'user',
        targetId: 'user9',
        targetLabel: '@troublemaker',
        metadata: { sessionsRevoked: 3 },
      },
    });
  });

  it('leaves metadata undefined when the caller omits it', async () => {
    const create = vi.fn().mockResolvedValue({});
    const tx = { adminAction: { create } } as never;

    await recordAdminAction(tx, {
      actorId: 'a', actorUsername: 'sam',
      action: ADMIN_ACTIONS.userUnban,
      targetType: 'user', targetId: 'u', targetLabel: '@x',
    });

    expect(create.mock.calls[0][0].data.metadata).toBeUndefined();
  });
});
