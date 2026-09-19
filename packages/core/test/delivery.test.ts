import { describe, expect, it } from 'vitest';
import {
  assetObjectKey,
  commitmentPeriodLabel,
  commitmentPeriodRange,
  commitmentPeriodStart,
  countsAsDelivered,
  deliveredAssetIds,
  hasCountableArtifacts,
  isTenantScopedKey,
  resolveDelivered,
  safeFileName,
} from '../src/delivery';

const asset = (over: Partial<Parameters<typeof countsAsDelivered>[0]> = {}) => ({
  id: 'a1',
  status: 'approved',
  supersededByAssetId: null,
  ...over,
});

describe('countsAsDelivered', () => {
  it('counts an approved asset', () => {
    expect(countsAsDelivered(asset())).toBe(true);
  });

  it('counts a published asset, so shipping work does not lower the figure', () => {
    expect(countsAsDelivered(asset({ status: 'published' }))).toBe(true);
  });

  it.each(['draft', 'submitted', 'in_review', 'changes_requested'])(
    'does not count %s: only a client decision makes an artifact delivered',
    (status) => {
      expect(countsAsDelivered(asset({ status }))).toBe(false);
    },
  );

  it('does not count a superseded version, however it was approved', () => {
    expect(countsAsDelivered(asset({ status: 'approved', supersededByAssetId: 'a2' }))).toBe(
      false,
    );
  });

  it('counts one article once across a version chain', () => {
    const ids = deliveredAssetIds([
      asset({ id: 'v1', status: 'approved', supersededByAssetId: 'v2' }),
      asset({ id: 'v2', status: 'approved' }),
    ]);
    expect(ids).toEqual(['v2']);
  });
});

describe('hasCountableArtifacts', () => {
  it('is false while everything is still a draft', () => {
    expect(hasCountableArtifacts([asset({ status: 'draft' })])).toBe(false);
  });

  it('is true once one asset has been put in front of the client', () => {
    expect(hasCountableArtifacts([asset({ status: 'draft' }), asset({ status: 'submitted' })])).toBe(
      true,
    );
  });

  it('is false where the only submitted asset has been superseded', () => {
    expect(
      hasCountableArtifacts([asset({ status: 'submitted', supersededByAssetId: 'v2' })]),
    ).toBe(false);
  });
});

describe('resolveDelivered', () => {
  it('is null when nothing has been recorded — not zero delivered', () => {
    expect(resolveDelivered({ derived: null, manual: null })).toBeNull();
  });

  it('uses the hand-recorded count where there is no artifact', () => {
    expect(resolveDelivered({ derived: null, manual: 34 })).toEqual({
      quantity: 34,
      source: 'manual',
      recordedByHand: null,
    });
  });

  it('prefers approved artifacts over a hand-recorded count', () => {
    expect(resolveDelivered({ derived: 12, manual: 20 })).toEqual({
      quantity: 12,
      source: 'derived_from_assets',
      recordedByHand: 20,
    });
  });

  it('never adds the two together', () => {
    const figure = resolveDelivered({ derived: 12, manual: 20 });
    expect(figure?.quantity).not.toBe(32);
  });

  it('states no discrepancy where the two agree', () => {
    expect(resolveDelivered({ derived: 8, manual: 8 })?.recordedByHand).toBeNull();
  });

  it('reports zero approved as a measurement once artifacts exist', () => {
    expect(resolveDelivered({ derived: 0, manual: null })).toEqual({
      quantity: 0,
      source: 'derived_from_assets',
      recordedByHand: null,
    });
  });
});

describe('commitment periods', () => {
  it('starts a monthly period on the first of the month', () => {
    expect(commitmentPeriodStart('monthly', '2026-09-19')).toBe('2026-09-01');
  });

  it.each([
    ['2026-01-04', '2026-01-01'],
    ['2026-03-31', '2026-01-01'],
    ['2026-04-01', '2026-04-01'],
    ['2026-09-19', '2026-07-01'],
    ['2026-12-31', '2026-10-01'],
  ])('puts %s in the quarter starting %s', (day, start) => {
    expect(commitmentPeriodStart('quarterly', day)).toBe(start);
  });

  it('closes a monthly range on the last day of the month', () => {
    expect(commitmentPeriodRange('monthly', '2026-02-10')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
  });

  it('closes a quarterly range on the last day of the quarter', () => {
    expect(commitmentPeriodRange('quarterly', '2026-09-19')).toEqual({
      start: '2026-07-01',
      end: '2026-09-30',
    });
  });

  it('labels the periods the way the screen names them', () => {
    expect(commitmentPeriodLabel('monthly', '2026-09-01')).toBe('September 2026');
    expect(commitmentPeriodLabel('quarterly', '2026-07-01')).toBe('Q3 2026');
  });
});

describe('object keys', () => {
  it('always lands under the tenant prefix', () => {
    const key = assetObjectKey({
      tenantId: '11111111-1111-1111-1111-111111111111',
      assetId: '22222222-2222-2222-2222-222222222222',
      version: 2,
      fileName: 'Q3 report.pdf',
    });
    expect(key).toBe(
      'tenant/11111111-1111-1111-1111-111111111111/assets/' +
        '22222222-2222-2222-2222-222222222222/v2/Q3-report.pdf',
    );
    expect(isTenantScopedKey(key, '11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isTenantScopedKey(key, '33333333-3333-3333-3333-333333333333')).toBe(false);
  });

  it('cannot be made to climb out of its prefix', () => {
    const key = assetObjectKey({
      tenantId: 't',
      assetId: 'a',
      version: 1,
      fileName: '../../../etc/passwd',
    });
    expect(key).toBe('tenant/t/assets/a/v1/passwd');
    expect(key).not.toContain('..');
  });

  it('keeps a usable name out of an unusable one', () => {
    expect(safeFileName('ad creative — “final” (v2).png')).toBe('ad-creative-final-v2.png');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('')).toBe('file');
  });
});
