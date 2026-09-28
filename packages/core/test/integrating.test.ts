import { describe, expect, it } from 'vitest';
import { INTEGRATION_PREVIEWS, parseIntegratingPlatforms, PENDING_STATE_LABELS, pendingPlatformState, stillIntegrating } from '../src/integrating';

describe('integrating platforms', () => {
  it('reads the config row, ignoring junk and repeats', () => {
    expect(parseIntegratingPlatforms({ platforms: ['linkedin_ads', 'semrush', 3, '', 'semrush'] })).toEqual([
      'linkedin_ads',
      'semrush',
    ]);
    expect(parseIntegratingPlatforms(null)).toEqual([]);
    expect(parseIntegratingPlatforms({ platforms: 'semrush' })).toEqual([]);
  });

  it('drops a platform the moment it reports, so its item becomes the ordinary page', () => {
    const configured = ['linkedin_ads', 'semrush', 'microsoft_ads'];
    expect(stillIntegrating(configured, ['google_ads', 'meta'])).toEqual(configured);
    expect(stillIntegrating(configured, ['google_ads', 'microsoft_ads'])).toEqual(['linkedin_ads', 'semrush']);
  });

  it('says what each of the three will show, in one line', () => {
    for (const key of ['linkedin_ads', 'semrush', 'microsoft_ads']) {
      const line = INTEGRATION_PREVIEWS[key]!;
      expect(line).toMatch(/^[A-Z].*\.$/);
      expect(line.split('. ').length).toBe(1);
      expect(line).not.toMatch(/\d/);
    }
  });
});

describe('pendingPlatformState', () => {
  it('is connected only with a stored grant on a working connection', () => {
    expect(pendingPlatformState({ authorized: true, status: 'degraded' })).toBe('connected');
    expect(pendingPlatformState({ authorized: true, status: 'healthy' })).toBe('connected');
    expect(pendingPlatformState({ authorized: true, status: 'waiting_on_client' })).toBe('integrating');
    expect(pendingPlatformState({ authorized: false, status: 'healthy' })).toBe('integrating');
    expect(pendingPlatformState(undefined)).toBe('integrating');
  });

  it('says so in words, with no figure', () => {
    expect(PENDING_STATE_LABELS.connected).toBe('Connected · no campaigns yet');
    expect(PENDING_STATE_LABELS.connected).not.toMatch(/\d/);
  });
});
