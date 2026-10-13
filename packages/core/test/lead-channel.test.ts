import { describe, expect, it } from 'vitest';
import {
  ORGANIC_SEARCH,
  isPaidChannel,
  leadChannel,
  parseLeadSourceRules,
  type LeadSourceEvidence,
} from '../src/lead-channel';
import { platformLabel } from '../src/platform-labels';

const rules = parseLeadSourceRules({
  utmSources: { google_ads: ['google'], meta: ['fb', 'facebook', 'ig'] },
  markerSources: {},
  referrerParams: { google_ads: ['gclid', 'gbraid', 'wbraid', 'gad_source'], meta: ['fbclid'] },
  referrerHosts: { meta: ['facebook.com', 'l.facebook.com', 'instagram.com'] },
  unknownPaidSources: ['100a00'],
  paidMediums: ['cpc', 'paid', 'paid_social', 'search'],
  unpaidMediums: ['organic'],
  leadSourceChannels: { 'Meta Ads': 'meta' },
  vendors: { popcrumbs: 'Popcrumbs', lendfax: 'Lendfax' },
  organicHosts: ['spartancapitalgroup.com', 'google.*', 'search.yahoo.com'],
  organicCapturePages: ['https://www.spartancapitalgroup.com/apply-now/'],
})!;

const lead = (over: Partial<LeadSourceEvidence>): LeadSourceEvidence => ({
  clickIdType: null,
  braid: null,
  referrerUrl: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  leadSource: 'Web',
  ...over,
});

describe('leadChannel', () => {
  it('credits a click ID first, whatever else the lead says', () => {
    expect(leadChannel(lead({ clickIdType: 'meta', utmSource: 'google', leadSource: 'popcrumbs' }), rules)).toBe('meta');
  });

  it('credits Google Ads for a gbraid/wbraid, or paid parameters on the referring URL', () => {
    expect(leadChannel(lead({ braid: 'wbraid-1', referrerUrl: 'https://www.google.com/' }), rules)).toBe('google_ads');
    const landing = 'https://apply.spartancapitalgroup.com/?gad_source=1&gad_campaignid=23718411293&gbraid=0AAAAA';
    expect(leadChannel(lead({ utmSource: '100A00', referrerUrl: landing }), rules)).toBe('google_ads');
  });

  it('credits Meta for an fbclid on the referring URL, or a Facebook or Instagram referrer', () => {
    const landing = 'https://apply.spartancapitalgroup.com/business-loans/?utm_source=meta&fbclid=IwY2xj';
    expect(leadChannel(lead({ utmSource: '100A00', referrerUrl: landing }), rules)).toBe('meta');
    expect(leadChannel(lead({ utmSource: '100A00', referrerUrl: 'https://l.facebook.com/' }), rules)).toBe('meta');
    expect(leadChannel(lead({ referrerUrl: 'https://instagram.com/' }), rules)).toBe('meta');
  });

  it('credits nobody for 100A00 alone, and does not let it pass for organic', () => {
    // Set by the landing page both platforms send traffic to (24 September 2026).
    expect(leadChannel(lead({ utmSource: '100A00' }), rules)).toBeNull();
    expect(leadChannel(lead({ utmSource: '100A00', referrerUrl: 'https://www.google.com/' }), rules)).toBeNull();
  });

  it('reads paid UTMs on the referring URL as platform evidence, ahead of the lead\'s own UTMs', () => {
    const landing = (q: string) => `https://apply.spartancapitalgroup.com/?${q}`;
    expect(
      leadChannel(lead({ utmSource: '100A00', utmMedium: 'cpc', referrerUrl: landing('utm_source=google&utm_medium=cpc&campaign_id=23718411293') }), rules),
    ).toBe('google_ads');
    expect(leadChannel(lead({ utmSource: '100A00', referrerUrl: landing('utm_source=fb&utm_medium=paid_social') }), rules)).toBe('meta');
    expect(leadChannel(lead({ referrerUrl: landing('utm_source=ig&campaign_id=120249615797590176') }), rules)).toBe('meta');
    // A channel's name alone, or declared organic, is not a paid click.
    expect(leadChannel(lead({ utmSource: '100A00', referrerUrl: landing('utm_source=google') }), rules)).toBeNull();
    expect(leadChannel(lead({ referrerUrl: 'https://www.google.com/?utm_source=google&utm_medium=organic' }), rules)).toBe(ORGANIC_SEARCH);
  });

  it('puts a vendor ahead of every UTM and referrer host, and behind a click ID (13 October 2026)', () => {
    const tagged = 'https://apply.spartancapitalgroup.com/?utm_source=fb&utm_medium=paid_social';
    expect(leadChannel(lead({ leadSource: 'popcrumbs', referrerUrl: tagged }), rules)).toBe('vendor:Popcrumbs');
    expect(leadChannel(lead({ leadSource: 'popcrumbs', utmSource: 'google', utmMedium: 'cpc' }), rules)).toBe('vendor:Popcrumbs');
    expect(leadChannel(lead({ leadSource: 'lendfax', referrerUrl: 'https://l.facebook.com/' }), rules)).toBe('vendor:Lendfax');
    expect(leadChannel(lead({ leadSource: 'popcrumbs', clickIdType: 'google_ads' }), rules)).toBe('google_ads');
    expect(leadChannel(lead({ leadSource: 'popcrumbs', referrerUrl: 'https://x.com/?gclid=abc' }), rules)).toBe('google_ads');
  });

  it('counts a lead submitted on a website form as SEO/Organic when nothing paid is present (13 October 2026)', () => {
    const form = 'https://www.spartancapitalgroup.com/apply-now?ref=nav';
    // The form writes 100A00 as its default; it does not stop the rule.
    expect(leadChannel(lead({ utmSource: '100A00', capturePage: form }), rules)).toBe(ORGANIC_SEARCH);
    expect(leadChannel(lead({ capturePage: 'https://spartancapitalgroup.com/apply-now/' }), rules)).toBe(ORGANIC_SEARCH);
    // Click IDs, paid UTMs and vendors still win.
    expect(leadChannel(lead({ utmSource: '100A00', capturePage: form, clickIdType: 'meta' }), rules)).toBe('meta');
    expect(leadChannel(lead({ utmSource: '100A00', capturePage: form, braid: 'g' }), rules)).toBe('google_ads');
    expect(leadChannel(lead({ utmSource: 'google', utmMedium: 'cpc', capturePage: form }), rules)).toBe('google_ads');
    expect(leadChannel(lead({ utmSource: '100A00', utmMedium: 'cpc', capturePage: form }), rules)).toBeNull();
    expect(leadChannel(lead({ leadSource: 'popcrumbs', capturePage: form }), rules)).toBe('vendor:Popcrumbs');
    // Another page is not the website form, and 100A00 there still rules out organic.
    expect(leadChannel(lead({ utmSource: '100A00', capturePage: 'https://apply.spartancapitalgroup.com/' }), rules)).toBeNull();
    expect(leadChannel(lead({ utmSource: '100A00', referrerUrl: 'https://www.google.com/' }), rules)).toBeNull();
  });

  it('credits Meta for its own lead forms', () => {
    expect(leadChannel(lead({ leadSource: 'Meta Ads' }), rules)).toBe('meta');
  });

  it('credits a paid UTM to the channel its source names', () => {
    expect(leadChannel(lead({ utmSource: 'google', utmMedium: 'cpc' }), rules)).toBe('google_ads');
    expect(leadChannel(lead({ utmSource: 'fb', utmMedium: 'paid' }), rules)).toBe('meta');
    expect(leadChannel(lead({ utmSource: 'ig', utmCampaign: '120249615797590176' }), rules)).toBe('meta');
    // A Google UTM declared organic is not Google Ads.
    expect(leadChannel(lead({ utmSource: 'google', utmMedium: 'organic', referrerUrl: 'https://www.google.com/' }), rules)).toBe(
      ORGANIC_SEARCH,
    );
    // Paid, but provably neither channel.
    expect(leadChannel(lead({ utmSource: 'debanked', utmMedium: 'paid' }), rules)).toBeNull();
  });

  it('names a lead vendor as its own source', () => {
    const vendor = leadChannel(lead({ leadSource: 'popcrumbs' }), rules)!;
    expect(vendor).toBe('vendor:Popcrumbs');
    expect(platformLabel(vendor)).toBe('Popcrumbs');
    expect(isPaidChannel(vendor)).toBe(false);
  });

  it('credits SEO/Organic for the website or a search result, with no paid signal', () => {
    expect(leadChannel(lead({ referrerUrl: 'https://www.spartancapitalgroup.com/resources/funding-guide' }), rules)).toBe(
      ORGANIC_SEARCH,
    );
    expect(leadChannel(lead({ referrerUrl: 'https://www.google.com/' }), rules)).toBe(ORGANIC_SEARCH);
    expect(leadChannel(lead({ referrerUrl: 'https://www.google.co.uk/', utmMedium: 'organic' }), rules)).toBe(ORGANIC_SEARCH);
    expect(leadChannel(lead({ referrerUrl: 'https://search.yahoo.com/' }), rules)).toBe(ORGANIC_SEARCH);
  });

  it('keeps anything less in Direct & other', () => {
    for (const over of [
      {},
      { referrerUrl: 'https://mail.google.com/' },
      { referrerUrl: 'android-app://com.google.android.gm/' },
      { referrerUrl: 'https://tagassistant.google.com/' },
      { referrerUrl: 'https://apply.spartancapitalgroup.com/' },
      { referrerUrl: 'https://www.google.com/', utmMedium: 'email' },
      { referrerUrl: 'https://www.google.com/', utmCampaign: 'spring-promo' },
    ] satisfies Partial<LeadSourceEvidence>[]) {
      expect(leadChannel(lead(over), rules), JSON.stringify(over)).toBeNull();
    }
  });

  it('credits only click IDs for a tenant with no rules', () => {
    expect(leadChannel(lead({ clickIdType: 'google_ads' }), null)).toBe('google_ads');
    expect(leadChannel(lead({ referrerUrl: 'https://www.google.com/', leadSource: 'Meta Ads' }), null)).toBeNull();
  });
});

describe('parseLeadSourceRules', () => {
  it('refuses a malformed row', () => {
    expect(parseLeadSourceRules(null)).toBeNull();
    expect(parseLeadSourceRules({ paidMediums: 'cpc' })).toBeNull();
    expect(parseLeadSourceRules({ vendors: { popcrumbs: '' } })).toBeNull();
  });
});
