import { describe, expect, it } from 'vitest';
import { landingParameterFor } from '../src/landing-parameters';

describe('landingParameterFor', () => {
  const row = { google_ads: { keyword: 'utm_term' }, meta: { ad: 'utm_content' } };

  it('reads each platform’s own detail', () => {
    expect(landingParameterFor(row, 'google_ads')).toBe('utm_term');
    expect(landingParameterFor(row, 'meta')).toBe('utm_content');
  });

  it('assumes nothing for a missing, malformed or foreign value', () => {
    expect(landingParameterFor(undefined, 'google_ads')).toBeNull();
    expect(landingParameterFor({}, 'meta')).toBeNull();
    expect(landingParameterFor({ meta: { keyword: 'utm_term' } }, 'meta')).toBeNull();
    expect(landingParameterFor({ google_ads: { keyword: 'landing_page' } }, 'google_ads')).toBeNull();
    expect(landingParameterFor(row, 'linkedin_ads')).toBeNull();
  });
});
