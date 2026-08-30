const Sequelize = require('sequelize');
const { sequelize } = require('./sequelize');

const TokenRefreshLockModel = sequelize.define('tokenRefreshLock', {
  userId: {
    type: Sequelize.STRING,
    primaryKey: true,
    field: 'user_id',
  },
  ownerId: {
    type: Sequelize.STRING,
    allowNull: false,
    field: 'owner_id',
  },
  expiresAt: {
    // Unix epoch milliseconds keep atomic expiry comparisons identical across
    // PostgreSQL production and SQLite tests.
    type: Sequelize.BIGINT,
    allowNull: false,
    field: 'expires_at',
  },
}, {
  tableName: 'token_refresh_locks',
  timestamps: false,
  indexes: [
    { fields: ['expires_at'] },
  ],
});

/**
 * Atomically acquires a lock when it does not exist or its lease has expired.
 * The single upsert statement avoids a read-then-write race across instances.
 */
async function acquireTokenRefreshLock({ userId, ownerId, ttlSeconds }) {
  const now = Date.now();
  const expiresAt = now + (ttlSeconds * 1000);
  const queryGenerator = sequelize.getQueryInterface().queryGenerator;
  const table = queryGenerator.quoteTable(TokenRefreshLockModel.getTableName());
  const userIdColumn = queryGenerator.quoteIdentifier('user_id');
  const ownerIdColumn = queryGenerator.quoteIdentifier('owner_id');
  const expiresAtColumn = queryGenerator.quoteIdentifier('expires_at');

  await sequelize.query(
    `INSERT INTO ${table} (${userIdColumn}, ${ownerIdColumn}, ${expiresAtColumn})
     VALUES (:userId, :ownerId, :expiresAt)
     ON CONFLICT (${userIdColumn}) DO UPDATE SET
       ${ownerIdColumn} = EXCLUDED.${ownerIdColumn},
       ${expiresAtColumn} = EXCLUDED.${expiresAtColumn}
     WHERE ${table}.${expiresAtColumn} <= :now`,
    {
      replacements: { userId, ownerId, expiresAt, now },
      type: Sequelize.QueryTypes.RAW,
    }
  );

  const lock = await TokenRefreshLockModel.findByPk(userId);
  return lock?.ownerId === ownerId;
}

async function getTokenRefreshLock(userId) {
  return TokenRefreshLockModel.findByPk(userId);
}

/**
 * Releases only the caller's lease. An expired owner cannot remove a newer
 * owner's replacement lock.
 */
async function releaseTokenRefreshLock({ userId, ownerId }) {
  return TokenRefreshLockModel.destroy({
    where: { userId, ownerId },
  });
}

exports.TokenRefreshLockModel = TokenRefreshLockModel;
exports.acquireTokenRefreshLock = acquireTokenRefreshLock;
exports.getTokenRefreshLock = getTokenRefreshLock;
exports.releaseTokenRefreshLock = releaseTokenRefreshLock;
