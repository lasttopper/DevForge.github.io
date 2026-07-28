-- =====================================================================
--  OMNICHANNEL AI SALES MACHINE — Supabase schema
--  Run this first, in the Supabase SQL Editor.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- leads : the business
-- ---------------------------------------------------------------------
create table if not exists public.leads (
    id                 uuid primary key default gen_random_uuid(),
    business_name      text not null,
    niche              text,
    location           text,
    status             text not null default 'new',
        -- new | contacted | engaged | prototype_sent | approved | payment_sent
        -- | paid | delivered | lost
    primary_contact_id uuid,
    google_place_id    text unique,
    prototype_url      text,
    final_site_url     text,
    metadata           jsonb not null default '{}'::jsonb,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- contacts : owners / managers of a business
-- ---------------------------------------------------------------------
create table if not exists public.contacts (
    id                 uuid primary key default gen_random_uuid(),
    lead_id            uuid references public.leads(id) on delete cascade,
    name               text,
    email              text,
    phone              text unique,
    channel_preference text not null default 'whatsapp',   -- email | whatsapp | both
    status             text not null default 'pending',
        -- pending | contacted | replied | locked | not_interested
    last_contacted_at  timestamptz,
    created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- payments : Razorpay tracking
-- ---------------------------------------------------------------------
create table if not exists public.payments (
    id                       uuid primary key default gen_random_uuid(),
    lead_id                  uuid references public.leads(id) on delete cascade,
    contact_id               uuid references public.contacts(id) on delete set null,
    razorpay_payment_link_id text unique,
    razorpay_payment_id      text,
    amount                   numeric,
    currency                 text not null default 'INR',
    status                   text not null default 'generated',  -- generated | paid | failed
    link_url                 text,
    paid_at                  timestamptz,
    created_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- messages : every inbound/outbound message (audit trail + AI context)
-- ---------------------------------------------------------------------
create table if not exists public.messages (
    id          uuid primary key default gen_random_uuid(),
    lead_id     uuid references public.leads(id) on delete cascade,
    contact_id  uuid references public.contacts(id) on delete cascade,
    direction   text not null,                 -- outbound | inbound
    channel     text not null,                 -- email | whatsapp
    subject     text,
    body        text,
    intent      text,                          -- INTERESTED | QUESTION | APPROVED | ...
    external_id text,
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------
create index if not exists idx_leads_status         on public.leads (status);
create index if not exists idx_leads_updated        on public.leads (updated_at desc);
create index if not exists idx_contacts_lead        on public.contacts (lead_id);
create index if not exists idx_contacts_email       on public.contacts (lower(email));
create index if not exists idx_contacts_phone       on public.contacts (phone);
create index if not exists idx_payments_lead        on public.payments (lead_id);
create index if not exists idx_payments_link        on public.payments (razorpay_payment_link_id);
create index if not exists idx_messages_lead        on public.messages (lead_id, created_at desc);
create index if not exists idx_messages_dedupe      on public.messages (external_id);

-- ---------------------------------------------------------------------
-- keep leads.updated_at fresh
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_leads_touch on public.leads;
create trigger trg_leads_touch
    before update on public.leads
    for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
-- n8n talks to Supabase with the SERVICE ROLE key, which bypasses RLS.
-- We still enable RLS so the anon key can never read your pipeline.
-- ---------------------------------------------------------------------
alter table public.leads    enable row level security;
alter table public.contacts enable row level security;
alter table public.payments enable row level security;
alter table public.messages enable row level security;
