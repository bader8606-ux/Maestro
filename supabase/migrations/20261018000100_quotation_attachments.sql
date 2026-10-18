-- Quotations are reference documents, independently classified from approval
-- evidence and purchase orders. Existing access and storage rules stay in force.
alter table public.maestro_attachments
  drop constraint maestro_attachments_kind_check;

alter table public.maestro_attachments
  add constraint maestro_attachments_kind_check
  check (kind in ('approval', 'purchase-order', 'logo', 'booth-location', 'booth-design', 'quotation'));
