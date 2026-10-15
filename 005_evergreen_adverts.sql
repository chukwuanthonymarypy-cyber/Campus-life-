-- Apply AFTER 002_public_adverts_avatars.sql, and before using open-ended adverts.
-- A NULL ends_on means the admin keeps this advert active until it is removed.
-- Paid placement and renewals remain manual; this migration performs no billing.
alter table public.campus_ads alter column ends_on drop not null;
comment on column public.campus_ads.ends_on is
  'Inclusive end date in Africa/Lagos; NULL means active until the admin removes the advert.';
