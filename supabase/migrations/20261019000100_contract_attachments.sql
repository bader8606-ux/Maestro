-- Contracts are stored independently from quotations, approval evidence, and
-- purchase orders. Adding a document does not change sponsorship workflow state.
alter table public.maestro_attachments
  drop constraint maestro_attachments_kind_check;

alter table public.maestro_attachments
  add constraint maestro_attachments_kind_check
  check (kind in ('approval', 'purchase-order', 'logo', 'booth-location', 'booth-design', 'quotation', 'contract'));
