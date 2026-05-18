const { Sequelize } = require('sequelize');

function shouldUseSsl(databaseUrl) {
  if (!databaseUrl) {
    return false;
  }
  if (process.env.DB_SSL != null) {
    return process.env.DB_SSL === 'true';
  }
  try {
    const hostname = new URL(databaseUrl).hostname;
    return hostname !== 'localhost' && hostname !== '127.0.0.1';
  }
  catch (_error) {
    return true;
  }
}

const sequelizeOptions = {
  dialect: 'postgres',
  protocol: 'postgres',
  logging: false
};

sequelizeOptions.dialectOptions = shouldUseSsl(process.env.DATABASE_URL)
  ? {
      ssl: {
        rejectUnauthorized: false
      }
    }
  : {
      ssl: false
    };

const sequelize = new Sequelize(process.env.DATABASE_URL, sequelizeOptions);
 

exports.sequelize = sequelize;
