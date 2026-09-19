import request from 'supertest';
import express from 'express';
import activityTimelineRouter from '../activityTimeline';

const app = express();
app.use(express.json());
app.use('/api/portfolio/activity', activityTimelineRouter);

describe('GET /api/portfolio/activity/:walletAddress', () => {
  it('returns a timeline for a valid wallet', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('walletAddress', 'GTESTWALLET');
    expect(res.body).toHaveProperty('timeline');
    expect(Array.isArray(res.body.timeline)).toBe(true);
  });

  it('filters by valid activity type', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET?types=deposit');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.timeline)).toBe(true);
  });

  it('filters by multiple valid types', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET?types=deposit,withdrawal');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.timeline)).toBe(true);
  });

  it('returns 400 for invalid activity type', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET?types=invalid_type');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toContain('invalid_type');
  });

  it('returns 400 for multiple invalid types', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET?types=bad1,bad2');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('bad1');
    expect(res.body.error).toContain('bad2');
  });

  it('returns 400 when mix of valid and invalid types', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET?types=deposit,bad1');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('bad1');
  });

  it('handles empty types parameter', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET?types=');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.timeline)).toBe(true);
  });

  it('handles missing types parameter', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET');

    expect(res.status).toBe(200);
  });

  it('returns timeline events with correct shape', async () => {
    const res = await request(app)
      .get('/api/portfolio/activity/GTESTWALLET');

    expect(res.status).toBe(200);
    for (const event of res.body.timeline) {
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('walletAddress');
      expect(event).toHaveProperty('type');
      expect(event).toHaveProperty('title');
      expect(event).toHaveProperty('description');
      expect(event).toHaveProperty('timestamp');
      expect(event).toHaveProperty('source');
    }
  });
});
