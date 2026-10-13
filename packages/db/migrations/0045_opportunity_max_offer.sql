-- ===========================================================================
-- The deal's highest offer.
--
-- Executive's "All funded" table shows the offered amount beside the deals
-- reaching Offer. A deal offered by several lenders, or a best and a
-- runner-up, counts once at its highest offer: Salesforce keeps that as a
-- roll-up on the Opportunity (`csbs__Max_Offer_Funded__c`, the largest
-- `csbs__Funded__c` across its `csbs__Offer__c` records), mapped as
-- `opportunity.maxOfferAmount`. Money, so numeric.
--
-- Additive, so it runs before the deploy: the sync writes the column.
-- ===========================================================================

ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "max_offer_amount" numeric(18, 2);
