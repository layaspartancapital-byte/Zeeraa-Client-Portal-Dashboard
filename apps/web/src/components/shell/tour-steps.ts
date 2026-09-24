/**
 * The product tour's steps: the page each belongs to, the `data-tour` element
 * it lights, and one plain sentence for a client (approved 24 September 2026).
 *
 * A plain module rather than part of `ProductTour.tsx`, so a test can read the
 * list without rendering anything — `test/product-tour.test.ts` fails if a
 * step names an element no source renders.
 */
export type TourStep = {
  /** Under `/{tenant}`: '' for Executive. */
  path: '' | '/funnel' | '/performance';
  target: string;
  title: string;
  caption: string;
};

export const STEPS: TourStep[] = [
  {
    path: '',
    target: 'date-range',
    title: 'Dates',
    caption: 'Choose the dates you want to see, and the figures on this page update to match.',
  },
  {
    path: '',
    target: 'scorecard',
    title: 'Against target',
    caption: 'This row shows how this month is going against the targets we agreed for Google Ads.',
  },
  {
    path: '',
    target: 'cost-chart',
    title: 'Cost per funded deal',
    caption:
      'This chart shows what each funded deal from Google Ads has cost, before we started and against each month’s target since.',
  },
  {
    path: '',
    target: 'freshness',
    title: 'How current the data is',
    caption: 'This strip shows when each data source last updated, so you know how current the numbers are.',
  },
  {
    path: '',
    target: 'how-measured',
    title: 'How this is measured',
    caption: 'Open this for a plain explanation of how every number on the page is worked out.',
  },
  {
    path: '/funnel',
    target: 'funnel',
    title: 'Funnel',
    caption: 'This page shows how many leads reach each stage, from first enquiry to funded deal.',
  },
  {
    path: '/performance',
    target: 'performance-table',
    title: 'Monthly performance',
    caption: 'This page breaks results down month by month, including the full set of target charts.',
  },
  {
    path: '/performance',
    target: 'export-csv',
    title: 'Export CSV',
    caption: 'This downloads the figures on the page as a spreadsheet.',
  },
];
