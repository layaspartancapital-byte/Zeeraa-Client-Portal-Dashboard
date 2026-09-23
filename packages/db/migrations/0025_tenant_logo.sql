-- ===========================================================================
-- A tenant's own logo, for the rail.
--
-- Stored on the tenant row as a `data:` URL rather than as a file, for two
-- reasons that are both about this product's rules rather than convenience:
--
-- * **This product stores no client files** (removed 21 September 2026). A
--   logo is one small image per tenant, and a column on a row every request
--   already reads keeps it out of any storage path.
-- * **No public URL.** A logo served from `/public` would be fetchable by
--   anyone who guessed `spartan.svg`, and the list of clients Zeeraa serves is
--   worth not publishing. On the row, it is read under the `tenants` policy —
--   a member of the tenant sees it, nobody else — and inlined into the page.
--
-- The check constraint admits raster images and SVG only, base64 only, and
-- 256 KB at most. Rendered through `<img>`, where an SVG cannot run script or
-- fetch anything. Null means no logo, and the rail falls back to initials.
--
-- Written by `packages/db/scripts/set-tenant-logo.ts`, never by the
-- application. Additive; runs before the deploy.
-- ===========================================================================

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS logo_data_url text;--> statement-breakpoint
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_logo_data_url_check CHECK (
    logo_data_url IS NULL
    OR (
      logo_data_url ~ '^data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$'
      AND length(logo_data_url) <= 262144
    )
  );
