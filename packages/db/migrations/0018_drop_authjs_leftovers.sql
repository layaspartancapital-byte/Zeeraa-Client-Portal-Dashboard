-- ===========================================================================
-- The Auth.js tables and column, after the deploy that stopped reading them.
--
-- The contract half of 0017's expand. These three are separated from it for one
-- reason: the deploy that was serving when 0017 ran hydrates every authenticated
-- request through the Drizzle adapter, and that selects `users.email_verified`.
-- Dropping it alongside the new columns would have taken down every signed-in
-- page for the length of the deploy, not merely the sign-in form.
--
-- Run this **after** the new deploy is live. By then nothing reads any of it:
-- `accounts` held OAuth provider links, `verification_tokens` held magic-link
-- tokens, and `email_verified` recorded that a link had been opened. There is no
-- OAuth, no link and no mailbox.
--
-- `sessions` is untouched and stays — it is the session store now.
-- ===========================================================================

DROP TABLE IF EXISTS "accounts";--> statement-breakpoint
DROP TABLE IF EXISTS "verification_tokens";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified";--> statement-breakpoint
