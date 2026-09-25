-- ===========================================================================
-- A tenant's square mark, for the collapsed rail.
--
-- The logo (0025) is a wordmark — Spartan's is 5.3:1 — and the rail collapsed
-- to 64px has room for a square only, so it has shown initials. A tenant whose
-- logo carries a symbol can store that symbol here, cropped from the same
-- artwork, and the collapsed rail shows it; null keeps the monogram.
--
-- The same rules as the logo: a `data:` URL on the row, read under the
-- `tenants` policy, never a public file; raster or SVG, base64 only; 64 KB at
-- most, since it renders at 28px. Written by `set-tenant-logo.ts --mark`,
-- never by the application. Additive; runs before the deploy.
-- ===========================================================================

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS mark_data_url text;--> statement-breakpoint
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_mark_data_url_check CHECK (
    mark_data_url IS NULL
    OR (
      mark_data_url ~ '^data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$'
      AND length(mark_data_url) <= 65536
    )
  );
