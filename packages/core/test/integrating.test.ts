import { describe, expect, it } from 'vitest';
import { INTEGRATION_PREVIEWS, parseIntegratingPlatforms, stillIntegrating } from '../src/integrating';

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
