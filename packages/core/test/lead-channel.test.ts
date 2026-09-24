import { describe, expect, it } from 'vitest';
import {
  ORGANIC_SEARCH,
  isOrganicSearch,
  leadChannel,
  parseOrganicSearchRule,
  type LeadSourceEvidence,
} from '../src/lead-channel';

const rule = parseOrganicSearchRule({
  searchHosts: ['google.*', 'bing.com', 'duckduckgo.com', 'search.yahoo.com'],
  unpaidMediums: ['organic'],
})!;

const lead = (over: Partial<LeadSourceEvidence>): LeadSourceEvidence => ({
  clickIdType: null,
  referrerUrl: 'https://www.google.com/',
  utmMedium: null,
  utmCampaign: null,
  ...over,
});

describe('isOrganicSearch', () => {
  it('holds for a search-results referrer with no paid signal', () => {
    expect(isOrganicSearch(lead({}), rule)).toBe(true);
    expect(isOrganicSearch(lead({ referrerUrl: 'https://search.yahoo.com/' }), rule)).toBe(true);
    expect(isOrganicSearch(lead({ referrerUrl: 'https://www.google.co.uk/' }), rule)).toBe(true);
    expect(isOrganicSearch(lead({ utmMedium: 'organic' }), rule)).toBe(true);
  });

  it('does not hold for a paid click that arrived from google.com', () => {
    expect(isOrganicSearch(lead({ clickIdType: 'google_ads' }), rule)).toBe(false);
    expect(isOrganicSearch(lead({ utmMedium: 'cpc' }), rule)).toBe(false);
    expect(isOrganicSearch(lead({ utmCampaign: 'SCG_Search_Qualified_v1' }), rule)).toBe(false);
  });

  it('does not treat Google properties that are not search as search', () => {
    for (const url of [
      'https://mail.google.com/',
      'android-app://com.google.android.gm/',
      'https://tagassistant.google.com/',
      'https://ads.google.com/',
    ]) {
      expect(isOrganicSearch(lead({ referrerUrl: url }), rule), url).toBe(false);
    }
  });

  it('leaves direct, social and unreadable referrers unattributed', () => {
    for (const url of [null, 'https://www.spartancapitalgroup.com/', 'https://l.facebook.com/', 'not a url']) {
      expect(isOrganicSearch(lead({ referrerUrl: url }), rule), String(url)).toBe(false);
    }
  });
});

describe('leadChannel', () => {
  it('is the click platform, else organic search, else nobody', () => {
    expect(leadChannel(lead({ clickIdType: 'meta' }), rule)).toBe('meta');
    expect(leadChannel(lead({}), rule)).toBe(ORGANIC_SEARCH);
    expect(leadChannel(lead({ referrerUrl: null }), rule)).toBeNull();
  });

  it('has no organic source for a tenant without the rule', () => {
    expect(leadChannel(lead({}), null)).toBeNull();
  });
});

describe('parseOrganicSearchRule', () => {
  it('refuses a row without hosts', () => {
    expect(parseOrganicSearchRule({ searchHosts: [] })).toBeNull();
    expect(parseOrganicSearchRule(null)).toBeNull();
  });
});
