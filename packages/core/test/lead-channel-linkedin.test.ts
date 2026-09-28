import { describe, expect, it } from 'vitest';
import { leadChannel, parseLeadSourceRules } from '../src/lead-channel';

/** The rows as `configure-linkedin` leaves them in production (28 September 2026). */
const rules = parseLeadSourceRules({
  utmSources: { google_ads: ['google'], meta: ['facebook'] },
  markerSources: {},
  referrerParams: {
    google_ads: ['gclid', 'gbraid', 'wbraid', 'gad_source'],
    meta: ['fbclid'],
    linkedin_ads: ['li_fat_id'],
  },
  referrerHosts: {},
  unknownPaidSources: ['100a00'],
  paidMediums: ['cpc', 'paid_social'],
  unpaidMediums: [],
  organicHosts: ['spartancapitalgroup.com'],
  vendors: {},
});

const lead = (over: Partial<Parameters<typeof leadChannel>[0]>) => ({
  clickIdType: null, referrerUrl: null, utmMedium: null, utmCampaign: null, ...over,
});

describe('li_fat_id as LinkedIn click evidence', () => {
  it('credits a landing URL carrying li_fat_id to LinkedIn Ads', () => {
    expect(leadChannel(lead({ referrerUrl: 'https://www.spartancapitalgroup.com/apply?li_fat_id=abc-123' }), rules)).toBe('linkedin_ads');
  });

  it('matches the parameter name case-insensitively, as the others are', () => {
    expect(leadChannel(lead({ referrerUrl: 'https://www.spartancapitalgroup.com/?LI_FAT_ID=abc' }), rules)).toBe('linkedin_ads');
  });

  it('takes the Salesforce field first when it is set (clickIdType linkedin_ads)', () => {
    expect(leadChannel(lead({ clickIdType: 'linkedin_ads', referrerUrl: 'https://x/?gclid=1' }), rules)).toBe('linkedin_ads');
  });

  it('lets utm_source=100A00 prove nothing, even next to li_fat_id', () => {
    expect(
      leadChannel(lead({ referrerUrl: 'https://www.spartancapitalgroup.com/?utm_source=100A00&li_fat_id=abc', utmSource: '100A00' }), rules),
    ).toBe('linkedin_ads');
  });
});
