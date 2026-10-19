-- Preserve the original Word contracts in the private bucket. The application
-- validates OOXML contents and accepts DOCX only in the contract section.
update storage.buckets
set allowed_mime_types = array[
  'image/png', 'image/jpeg', 'image/webp', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]
where id = 'maestro-files';
