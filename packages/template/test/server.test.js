const request = require('supertest');
const { app } = require('../src/app');

describe('Server', () => {
  describe('GET /isAlive', () => {
    test('should return health status', async () => {
      const response = await request(app)
        .get('/isAlive')
        .expect(200);
      expect(response.text).toBe('OK');
    });
  });
});
