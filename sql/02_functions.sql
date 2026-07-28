-- =====================================================================
--  OMNICHANNEL AI SALES MACHINE — RPC helper functions
--  Run this AFTER 01_schema.sql.
--
--  Why RPCs instead of chains of Supabase nodes?
--    * atomic  – dedupe + insert happen in ONE statement, so two parallel
--                n8n executions can never create duplicate leads
--    * fewer   – one HTTP call instead of 4-5 (free-tier friendly)
--    * safer   – the "lock the lead to one contact" step is a single
--                transaction instead of a read-modify-write loop
--
--  Call them from n8n with:
--    POST {{supabase_url}}/rest/v1/rpc/<function_name>
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. sales_upsert_lead(payload jsonb)
--    Dedupe + insert a business and its primary contact in one shot.
--    Returns the lead/contact ids and whether it was newly created.
-- ---------------------------------------------------------------------
create or replace function public.sales_upsert_lead(p_payload jsonb)
returns table (
    lead_id            uuid,
    contact_id         uuid,
    is_new             boolean,
    business_name      text,
    niche              text,
    location           text,
    contact_name       text,
    email              text,
    phone              text,
    channel_preference text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_place_id   text := nullif(trim(p_payload->>'google_place_id'), '');
    v_phone      text := nullif(trim(p_payload->>'phone'), '');
    v_email      text := lower(nullif(trim(p_payload->>'email'), ''));
    v_name       text := nullif(trim(p_payload->>'business_name'), '');
    v_lead_id    uuid;
    v_contact_id uuid;
    v_is_new     boolean := false;
    v_channel    text;
begin
    if v_name is null then
        raise exception 'business_name is required';
    end if;

    -- already known? (by place id, phone or email)
    select l.id into v_lead_id
    from public.leads l
    where (v_place_id is not null and l.google_place_id = v_place_id)
    limit 1;

    if v_lead_id is null and (v_phone is not null or v_email is not null) then
        select c.lead_id into v_lead_id
        from public.contacts c
        where (v_phone is not null and c.phone = v_phone)
           or (v_email is not null and lower(c.email) = v_email)
        limit 1;
    end if;

    if v_lead_id is null then
        insert into public.leads (business_name, niche, location, status,
                                  google_place_id, metadata)
        values (
            v_name,
            nullif(trim(p_payload->>'niche'), ''),
            nullif(trim(p_payload->>'location'), ''),
            'new',
            v_place_id,
            coalesce(p_payload->'metadata', '{}'::jsonb)
        )
        returning id into v_lead_id;
        v_is_new := true;
    end if;

    v_channel := case
        when v_email is not null and v_phone is not null then 'both'
        when v_email is not null then 'email'
        when v_phone is not null then 'whatsapp'
        else 'none'
    end;

    -- contact: match on phone first, then email, else create
    select c.id into v_contact_id
    from public.contacts c
    where c.lead_id = v_lead_id
      and ((v_phone is not null and c.phone = v_phone)
        or (v_email is not null and lower(c.email) = v_email))
    limit 1;

    if v_contact_id is null then
        insert into public.contacts (lead_id, name, email, phone,
                                     channel_preference, status)
        values (
            v_lead_id,
            coalesce(nullif(trim(p_payload->>'contact_name'), ''), 'Owner'),
            v_email,
            v_phone,
            v_channel,
            'pending'
        )
        on conflict (phone) do update set lead_id = excluded.lead_id
        returning id into v_contact_id;
    end if;

    return query
    select v_lead_id,
           v_contact_id,
           v_is_new,
           l.business_name,
           l.niche,
           l.location,
           c.name,
           c.email,
           c.phone,
           c.channel_preference
    from public.leads l
    join public.contacts c on c.id = v_contact_id
    where l.id = v_lead_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. sales_find_contact(identifier text)
--    Resolve an inbound email address OR phone number to lead + contact.
--    Phone matching is fuzzy (last 10 digits) because WhatsApp JIDs,
--    Google Maps and what the owner typed rarely agree on formatting.
-- ---------------------------------------------------------------------
create or replace function public.sales_find_contact(p_identifier text)
returns table (
    contact_id     uuid,
    lead_id        uuid,
    contact_name   text,
    email          text,
    phone          text,
    contact_status text,
    business_name  text,
    niche          text,
    location       text,
    lead_status    text,
    prototype_url  text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_raw    text := lower(trim(coalesce(p_identifier, '')));
    v_digits text := regexp_replace(coalesce(p_identifier, ''), '\D', '', 'g');
    v_tail   text := right(v_digits, 10);
begin
    return query
    select c.id, c.lead_id, c.name, c.email, c.phone, c.status,
           l.business_name, l.niche, l.location, l.status, l.prototype_url
    from public.contacts c
    join public.leads l on l.id = c.lead_id
    where (v_raw like '%@%' and lower(c.email) = v_raw)
       or (length(v_tail) = 10 and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = v_tail)
    order by c.last_contacted_at desc nulls last
    limit 1;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. sales_lock_lead(lead_id, contact_id)
--    The replier becomes THE contact; everyone else on that business is
--    locked out so we never talk to two people at the same company.
-- ---------------------------------------------------------------------
create or replace function public.sales_lock_lead(p_lead_id uuid, p_contact_id uuid)
returns table (lead_id uuid, primary_contact_id uuid, status text, locked_out integer)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_locked integer;
begin
    update public.contacts
       set status = 'replied'
     where id = p_contact_id;

    update public.contacts
       set status = 'locked'
     where lead_id = p_lead_id
       and id <> p_contact_id
       and status not in ('locked', 'not_interested');
    get diagnostics v_locked = row_count;

    update public.leads
       set status = case when status in ('new', 'contacted') then 'engaged' else status end,
           primary_contact_id = p_contact_id
     where id = p_lead_id;

    return query
    select l.id, l.primary_contact_id, l.status, v_locked
    from public.leads l
    where l.id = p_lead_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. sales_claim_leads(from_status, to_status, limit)
--    Atomically claim work so two n8n runs never build the same
--    prototype twice. Uses FOR UPDATE SKIP LOCKED.
-- ---------------------------------------------------------------------
create or replace function public.sales_claim_leads(
    p_from_status text,
    p_to_status   text,
    p_limit       integer default 5
)
returns table (
    lead_id       uuid,
    business_name text,
    niche         text,
    location      text,
    prototype_url text,
    contact_id    uuid,
    contact_name  text,
    email         text,
    phone         text,
    metadata      jsonb
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
    return query
    with claimed as (
        select l.id
        from public.leads l
        where l.status = p_from_status
        order by l.updated_at asc
        limit greatest(p_limit, 1)
        for update skip locked
    ),
    bumped as (
        update public.leads l
           set status = p_to_status
          from claimed
         where l.id = claimed.id
        returning l.*
    )
    select b.id, b.business_name, b.niche, b.location, b.prototype_url,
           c.id, c.name, c.email, c.phone, b.metadata
    from bumped b
    left join public.contacts c
           on c.id = coalesce(b.primary_contact_id,
                              (select c2.id from public.contacts c2
                                where c2.lead_id = b.id
                                order by c2.created_at limit 1));
end;
$$;

-- ---------------------------------------------------------------------
-- 5. sales_record_payment_paid(payment_link_id, razorpay_payment_id, amount)
--    Idempotent: replaying the same Razorpay webhook is a no-op.
-- ---------------------------------------------------------------------
create or replace function public.sales_record_payment_paid(
    p_link_id    text,
    p_payment_id text default null,
    p_amount     numeric default null
)
returns table (
    lead_id       uuid,
    business_name text,
    niche         text,
    location      text,
    prototype_url text,
    contact_name  text,
    email         text,
    phone         text,
    amount        numeric,
    already_paid  boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_lead_id      uuid;
    v_already_paid boolean := false;
begin
    select p.lead_id, (p.status = 'paid')
      into v_lead_id, v_already_paid
      from public.payments p
     where p.razorpay_payment_link_id = p_link_id;

    if v_lead_id is null then
        return;   -- unknown link: caller decides what to do
    end if;

    if not v_already_paid then
        update public.payments
           set status              = 'paid',
               razorpay_payment_id = coalesce(p_payment_id, razorpay_payment_id),
               amount              = coalesce(p_amount, amount),
               paid_at             = now()
         where razorpay_payment_link_id = p_link_id;

        update public.leads
           set status = 'paid'
         where id = v_lead_id;
    end if;

    return query
    select l.id, l.business_name, l.niche, l.location, l.prototype_url,
           c.name, c.email, c.phone,
           (select pp.amount from public.payments pp
             where pp.razorpay_payment_link_id = p_link_id),
           v_already_paid
    from public.leads l
    left join public.contacts c on c.id = l.primary_contact_id
    where l.id = v_lead_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. sales_log_message(...) – append to the audit trail
-- ---------------------------------------------------------------------
create or replace function public.sales_log_message(
    p_lead_id    uuid,
    p_contact_id uuid,
    p_direction  text,
    p_channel    text,
    p_body       text,
    p_subject    text default null,
    p_intent     text default null,
    p_external_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_id uuid;
begin
    -- de-duplicate webhook replays
    if p_external_id is not null then
        select id into v_id from public.messages where external_id = p_external_id limit 1;
        if v_id is not null then
            return v_id;
        end if;
    end if;

    insert into public.messages (lead_id, contact_id, direction, channel,
                                 subject, body, intent, external_id)
    values (p_lead_id, p_contact_id, p_direction, p_channel,
            p_subject, p_body, p_intent, p_external_id)
    returning id into v_id;

    return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. sales_mark_contacted(contact_id, lead_id)
-- ---------------------------------------------------------------------
create or replace function public.sales_mark_contacted(
    p_contact_id uuid,
    p_lead_id    uuid
)
returns table (contact_id uuid, lead_id uuid, lead_status text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
    update public.contacts
       set status            = case when status = 'pending' then 'contacted' else status end,
           last_contacted_at = now()
     where id = p_contact_id;

    update public.leads
       set status = case when status = 'new' then 'contacted' else status end
     where id = p_lead_id;

    return query
    select p_contact_id, l.id, l.status
    from public.leads l
    where l.id = p_lead_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. sales_mark_lost(lead_id, contact_id)
-- ---------------------------------------------------------------------
create or replace function public.sales_mark_lost(
    p_lead_id    uuid,
    p_contact_id uuid
)
returns table (lead_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
    update public.contacts
       set status = 'not_interested'
     where id = p_contact_id;

    -- only give up on the whole business if nobody else is still open
    update public.leads l
       set status = 'lost'
     where l.id = p_lead_id
       and not exists (
           select 1 from public.contacts c
            where c.lead_id = p_lead_id
              and c.id <> p_contact_id
              and c.status in ('pending', 'contacted', 'replied')
       )
       and l.status not in ('paid', 'delivered');

    return query
    select l.id, l.status from public.leads l where l.id = p_lead_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. sales_set_prototype(lead_id, url)
-- ---------------------------------------------------------------------
create or replace function public.sales_set_prototype(
    p_lead_id uuid,
    p_url     text
)
returns table (lead_id uuid, status text, prototype_url text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
    update public.leads
       set prototype_url = p_url,
           status        = 'prototype_sent',
           metadata      = metadata || jsonb_build_object(
                               'prototype_url', p_url,
                               'prototype_built_at', now())
     where id = p_lead_id;

    return query
    select l.id, l.status, l.prototype_url from public.leads l where l.id = p_lead_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 10. sales_create_payment(lead_id, contact_id, link_id, amount, currency, url)
-- ---------------------------------------------------------------------
create or replace function public.sales_create_payment(
    p_lead_id    uuid,
    p_contact_id uuid,
    p_link_id    text,
    p_amount     numeric,
    p_currency   text,
    p_url        text
)
returns table (payment_id uuid, lead_id uuid, link_url text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    v_id uuid;
begin
    insert into public.payments (lead_id, contact_id, razorpay_payment_link_id,
                                 amount, currency, status, link_url)
    values (p_lead_id, p_contact_id, p_link_id, p_amount,
            coalesce(p_currency, 'INR'), 'generated', p_url)
    on conflict (razorpay_payment_link_id) do update
        set link_url = excluded.link_url
    returning id into v_id;

    update public.leads
       set status = case when status in ('paid', 'delivered') then status
                         else 'payment_sent' end
     where id = p_lead_id;

    return query select v_id, p_lead_id, p_url;
end;
$$;

-- ---------------------------------------------------------------------
-- 11. sales_get_lead(lead_id) – lead + its primary contact in one row
-- ---------------------------------------------------------------------
create or replace function public.sales_get_lead(p_lead_id uuid)
returns table (
    lead_id       uuid,
    business_name text,
    niche         text,
    location      text,
    lead_status   text,
    prototype_url text,
    metadata      jsonb,
    contact_id    uuid,
    contact_name  text,
    email         text,
    phone         text,
    channel_preference text
)
language sql
security definer
set search_path = public
as $$
    select l.id, l.business_name, l.niche, l.location, l.status, l.prototype_url,
           l.metadata, c.id, c.name, c.email, c.phone, c.channel_preference
    from public.leads l
    left join public.contacts c
           on c.id = coalesce(l.primary_contact_id,
                              (select c2.id from public.contacts c2
                                where c2.lead_id = l.id
                                order by c2.created_at limit 1))
    where l.id = p_lead_id;
$$;

-- ---------------------------------------------------------------------
-- 12. sales_mark_delivered(lead_id, final_url)
-- ---------------------------------------------------------------------
create or replace function public.sales_mark_delivered(
    p_lead_id uuid,
    p_url     text
)
returns table (lead_id uuid, status text, final_site_url text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
    update public.leads
       set final_site_url = p_url,
           status         = 'delivered',
           metadata       = metadata || jsonb_build_object('delivered_at', now())
     where id = p_lead_id;

    return query
    select l.id, l.status, l.final_site_url from public.leads l where l.id = p_lead_id;
end;
$$;
