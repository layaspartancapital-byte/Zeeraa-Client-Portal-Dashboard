import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { NotMeasuredBadge } from '@/components/ui/Badge';

/**
 * A card whose source has not been read for the range at all.
 *
 * Stands in for the card it replaces, with the same title, so the screen keeps
 * its shape and says what is missing where the figure would have been — never
 * a table of zeros, which reads as a period in which nothing happened. The
 * reason comes from `notMeasuredReason` in `lib/coverage.ts`, so every screen
 * words it the same way.
 */
export function NotMeasuredCard({
  title,
  subtitle,
  reason,
  span = 12,
  className = '',
}: {
  title: string;
  subtitle?: string;
  reason: string;
  span?: 3 | 4 | 6 | 8 | 12;
  className?: string;
}) {
  return (
    <Card span={span} className={className}>
      <CardHeader title={title} subtitle={subtitle} />
      <CardBody>
        <EmptyLine action={<NotMeasuredBadge />}>{reason}</EmptyLine>
      </CardBody>
    </Card>
  );
}
