const {
  TokenRefreshLockModel,
  acquireTokenRefreshLock,
  getTokenRefreshLock,
  releaseTokenRefreshLock,
} = require('../../models/tokenRefreshLockModel');

describe('TokenRefreshLockModel', () => {
  beforeAll(async () => {
    await TokenRefreshLockModel.sync({ force: true });
  });

  beforeEach(async () => {
    await TokenRefreshLockModel.destroy({ where: {} });
  });

  test('allows exactly one owner to acquire an active lock', async () => {
    const results = await Promise.all([
      acquireTokenRefreshLock({ userId: 'user-1', ownerId: 'owner-a', ttlSeconds: 30 }),
      acquireTokenRefreshLock({ userId: 'user-1', ownerId: 'owner-b', ttlSeconds: 30 }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const lock = await getTokenRefreshLock('user-1');
    expect(['owner-a', 'owner-b']).toContain(lock.ownerId);
  });

  test('atomically replaces an expired lock', async () => {
    await TokenRefreshLockModel.create({
      userId: 'user-2',
      ownerId: 'expired-owner',
      expiresAt: Date.now() - 1000,
    });

    const acquired = await acquireTokenRefreshLock({
      userId: 'user-2',
      ownerId: 'new-owner',
      ttlSeconds: 30,
    });

    expect(acquired).toBe(true);
    const lock = await getTokenRefreshLock('user-2');
    expect(lock.ownerId).toBe('new-owner');
    expect(Number(lock.expiresAt)).toBeGreaterThan(Date.now());
  });

  test('an old owner cannot release a replacement lock', async () => {
    await TokenRefreshLockModel.create({
      userId: 'user-3',
      ownerId: 'new-owner',
      expiresAt: Date.now() + 30000,
    });

    const oldOwnerReleaseCount = await releaseTokenRefreshLock({
      userId: 'user-3',
      ownerId: 'old-owner',
    });
    expect(oldOwnerReleaseCount).toBe(0);
    expect(await getTokenRefreshLock('user-3')).not.toBeNull();

    const newOwnerReleaseCount = await releaseTokenRefreshLock({
      userId: 'user-3',
      ownerId: 'new-owner',
    });
    expect(newOwnerReleaseCount).toBe(1);
    expect(await getTokenRefreshLock('user-3')).toBeNull();
  });
});
