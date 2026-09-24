import { Card, CardHeader } from '@/components/ui/Card';

/**
 * A section still loading: its card and title where it will be, and muted
 * bars where its figures go, so the page does not jump when it arrives.
 *
 * For a `<Suspense>` boundary around a slow section (24 September 2026). No
 * spinner and no words: it is the same card a moment early, not a status.
 */
export function SectionSkeleton({
  title,
  span = 12,
  rows = 3,
}: {
  title: string;
  span?: 4 | 6 | 8 | 12;
  rows?: number;
}) {
  return (
    <Card span={span} aria-busy="true">
      <CardHeader title={title} />
      <div className="space-y-3 border-t border-border px-5 py-4">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="h-3 rounded bg-canvas motion-safe:animate-pulse"
            style={{ width: `${88 - i * 17}%` }}
          />
        ))}
      </div>
    </Card>
  );
}
