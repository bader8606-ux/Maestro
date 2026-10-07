-- Expand attachment sections without rewriting existing records or policies.
alter table public.maestro_attachments
  drop constraint maestro_attachments_kind_check;

alter table public.maestro_attachments
  add constraint maestro_attachments_kind_check
  check (kind in ('approval', 'purchase-order', 'logo', 'booth-location', 'booth-design'));

-- Booth size and location are optional strings in each sponsor's existing JSON
-- record. Legacy records stay unchanged; API responses expose empty strings.
