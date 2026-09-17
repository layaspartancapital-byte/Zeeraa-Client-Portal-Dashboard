ALTER TABLE "leads" ADD COLUMN "self_reported_annual_revenue" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "revenue_figures_disagree" boolean DEFAULT false NOT NULL;