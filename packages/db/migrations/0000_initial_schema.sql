CREATE TYPE "public"."asset_status" AS ENUM('draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'published');--> statement-breakpoint
CREATE TYPE "public"."attribution_model" AS ENUM('first_touch', 'last_touch');--> statement-breakpoint
CREATE TYPE "public"."commitment_period" AS ENUM('monthly', 'quarterly');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('not_configured', 'healthy', 'degraded', 'failing', 'waiting_on_client');--> statement-breakpoint
CREATE TYPE "public"."data_source_kind" AS ENUM('api', 'manual', 'derived_from_assets');--> statement-breakpoint
CREATE TYPE "public"."deliverable_source" AS ENUM('manual', 'derived_from_assets');--> statement-breakpoint
CREATE TYPE "public"."improvement_direction" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."mention_source" AS ENUM('asset', 'comment');--> statement-breakpoint
CREATE TYPE "public"."notification_channel_pref" AS ENUM('instant', 'digest', 'off');--> statement-breakpoint
CREATE TYPE "public"."organic_source" AS ENUM('gsc', 'ga4', 'semrush');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('zeeraa_admin', 'zeeraa_member', 'client_admin', 'client_viewer');--> statement-breakpoint
CREATE TYPE "public"."sla_event_type" AS ENUM('slack_response', 'daily_update', 'weekly_call', 'monthly_report', 'qbr');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'succeeded', 'partial', 'failed', 'dead_lettered');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"account_identifier" text NOT NULL,
	"credentials_encrypted" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "connection_status" DEFAULT 'not_configured' NOT NULL,
	"blocked_reason" text,
	"blocked_since" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"slack_user_id" text,
	"email_preference" "notification_channel_pref" DEFAULT 'instant' NOT NULL,
	"slack_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"accent_color" text DEFAULT '#8A6B1F' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"title" text,
	"email_verified" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fact_key" text NOT NULL,
	"kind" "data_source_kind" NOT NULL,
	"platform" text,
	"sync_run_id" uuid,
	"recorded_by_user_id" uuid,
	"asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"as_of" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_written" numeric(12, 0) DEFAULT '0' NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"error" text,
	"attempt" numeric(4, 0) DEFAULT '1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_account_id" text NOT NULL,
	"name" text NOT NULL,
	"account_timezone" text,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" date NOT NULL,
	"prompt" text NOT NULL,
	"engine" text NOT NULL,
	"cited" boolean NOT NULL,
	"competitor_cited" text,
	"position" integer,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid,
	"platform" text NOT NULL,
	"external_campaign_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text,
	"product" text,
	"industry" text,
	"keyword_tier" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"date" date NOT NULL,
	"campaign_id" uuid,
	"impressions" numeric(20, 0) DEFAULT '0' NOT NULL,
	"clicks" numeric(20, 0) DEFAULT '0' NOT NULL,
	"spend" numeric(18, 4) DEFAULT '0' NOT NULL,
	"platform_conversions" numeric(18, 4) DEFAULT '0' NOT NULL,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organic_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"date" date NOT NULL,
	"source" "organic_source" NOT NULL,
	"dimension" text NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_external_id" text NOT NULL,
	"model" "attribution_model" NOT NULL,
	"platform" text,
	"campaign_id" uuid,
	"click_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"click_id" text,
	"click_id_type" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"landing_page" text,
	"self_reported_revenue" numeric(18, 2),
	"self_reported_time_in_business" numeric(8, 2),
	"industry" text,
	"state" text,
	"is_duplicate" boolean DEFAULT false NOT NULL,
	"duplicate_of" text,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"lead_external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"current_stage" text NOT NULL,
	"amount" numeric(18, 2),
	"funded_amount" numeric(18, 2),
	"decline_reason" text,
	"industry" text,
	"state" text,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_external_id" text NOT NULL,
	"stage" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"sync_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"platform" text,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"metrics" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"is_optimization_target" boolean DEFAULT false NOT NULL,
	"counts_value" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"threshold_value" numeric(18, 2) NOT NULL,
	"reached_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reconciliation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"claims" jsonb NOT NULL,
	"question" text NOT NULL,
	"resolved_value" text,
	"resolved_note" text,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"formula_key" text NOT NULL,
	"formula_args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_value" numeric(18, 4),
	"improvement_direction" "improvement_direction" NOT NULL,
	"is_north_star" boolean DEFAULT false NOT NULL,
	"needs_reconciliation" boolean DEFAULT false NOT NULL,
	"reconciliation_note" text,
	"definition" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverable_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"committed_quantity" numeric(12, 2) NOT NULL,
	"committed_quantity_max" numeric(12, 2),
	"period" "commitment_period" NOT NULL,
	"unit" text NOT NULL,
	"requires_client_approval" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverable_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"commitment_key" text NOT NULL,
	"period_start" date NOT NULL,
	"delivered_quantity" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "deliverable_source" DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "sla_event_type" NOT NULL,
	"label" text NOT NULL,
	"target_minutes" integer,
	"cadence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "sla_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"response_minutes" integer,
	"notes" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"verb" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "asset_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"commitment_key" text,
	"period_start" date,
	"file_key" text,
	"file_name" text,
	"mime_type" text,
	"size_bytes" bigint,
	"external_url" text,
	"status" "asset_status" DEFAULT 'draft' NOT NULL,
	"uploaded_by_user_id" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"changes_requested_reason" text,
	"published_at" timestamp with time zone,
	"published_url" text,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_type" "mention_source" NOT NULL,
	"source_id" uuid NOT NULL,
	"mentioned_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"delivered_email_at" timestamp with time zone,
	"delivered_slack_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility" ADD CONSTRAINT "ai_visibility_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility" ADD CONSTRAINT "ai_visibility_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organic_metrics" ADD CONSTRAINT "organic_metrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organic_metrics" ADD CONSTRAINT "organic_metrics_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution" ADD CONSTRAINT "attribution_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution" ADD CONSTRAINT "attribution_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD CONSTRAINT "funnel_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD CONSTRAINT "tenant_config_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_metrics" ADD CONSTRAINT "tenant_metrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_commitments" ADD CONSTRAINT "deliverable_commitments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_records" ADD CONSTRAINT "deliverable_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_records" ADD CONSTRAINT "deliverable_records_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_commitments" ADD CONSTRAINT "sla_commitments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_comments" ADD CONSTRAINT "asset_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_comments" ADD CONSTRAINT "asset_comments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_comments" ADD CONSTRAINT "asset_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_comments" ADD CONSTRAINT "asset_comments_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_mentioned_user_id_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_platform_account_key" ON "connections" USING btree ("tenant_id","platform","account_identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_tenant_key" ON "memberships" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE INDEX "memberships_tenant_idx" ON "memberships" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "data_sources_tenant_fact_key" ON "data_sources" USING btree ("tenant_id","fact_key");--> statement-breakpoint
CREATE INDEX "sync_runs_tenant_platform_started_idx" ON "sync_runs" USING btree ("tenant_id","platform","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_tenant_platform_external_key" ON "ad_accounts" USING btree ("tenant_id","platform","external_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_upsert_key" ON "ai_visibility" USING btree ("tenant_id","period","engine","prompt");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_tenant_platform_external_key" ON "campaigns" USING btree ("tenant_id","platform","external_campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_tenant_platform_idx" ON "campaigns" USING btree ("tenant_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_metrics_upsert_key" ON "daily_metrics" USING btree ("tenant_id","platform","date",coalesce("campaign_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "daily_metrics_tenant_date_idx" ON "daily_metrics" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "organic_metrics_upsert_key" ON "organic_metrics" USING btree ("tenant_id","source","date","dimension");--> statement-breakpoint
CREATE INDEX "organic_metrics_tenant_date_idx" ON "organic_metrics" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "attribution_upsert_key" ON "attribution" USING btree ("tenant_id","opportunity_external_id","model");--> statement-breakpoint
CREATE INDEX "attribution_tenant_model_campaign_idx" ON "attribution" USING btree ("tenant_id","model","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_tenant_external_key" ON "leads" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "leads_tenant_created_idx" ON "leads" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_tenant_click_id_idx" ON "leads" USING btree ("tenant_id","click_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_tenant_external_key" ON "opportunities" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "opportunities_tenant_created_idx" ON "opportunities" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "opportunities_tenant_lead_idx" ON "opportunities" USING btree ("tenant_id","lead_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_events_upsert_key" ON "stage_events" USING btree ("tenant_id","opportunity_external_id","stage","occurred_at");--> statement-breakpoint
CREATE INDEX "stage_events_tenant_stage_idx" ON "stage_events" USING btree ("tenant_id","stage","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "baselines_tenant_key_key" ON "baselines" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_stages_tenant_key_key" ON "funnel_stages" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_stages_tenant_position_key" ON "funnel_stages" USING btree ("tenant_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_tenant_metric_position_key" ON "milestones" USING btree ("tenant_id","metric_key","position");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_items_tenant_key_key" ON "reconciliation_items" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_config_tenant_key_key" ON "tenant_config" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_metrics_tenant_key_key" ON "tenant_metrics" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "deliverable_commitments_tenant_key_key" ON "deliverable_commitments" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "deliverable_records_upsert_key" ON "deliverable_records" USING btree ("tenant_id","commitment_key","period_start","source");--> statement-breakpoint
CREATE INDEX "deliverable_records_tenant_period_idx" ON "deliverable_records" USING btree ("tenant_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_commitments_tenant_type_key" ON "sla_commitments" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "sla_events_tenant_type_occurred_idx" ON "sla_events" USING btree ("tenant_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_log_tenant_created_idx" ON "activity_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "asset_comments_tenant_asset_idx" ON "asset_comments" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_types_tenant_key_key" ON "asset_types" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "assets_tenant_status_idx" ON "assets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "assets_tenant_commitment_period_idx" ON "assets" USING btree ("tenant_id","commitment_key","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_unique_key" ON "mentions" USING btree ("tenant_id","source_type","source_id","mentioned_user_id");--> statement-breakpoint
CREATE INDEX "mentions_tenant_user_idx" ON "mentions" USING btree ("tenant_id","mentioned_user_id");--> statement-breakpoint
CREATE INDEX "notifications_tenant_user_created_idx" ON "notifications" USING btree ("tenant_id","user_id","created_at");