ALTER TABLE public.assessment
  ADD COLUMN IF NOT EXISTS target_class_id text REFERENCES public."class"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_department text;

ALTER TABLE public.support_ticket
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS contact_email text;

ALTER TABLE public.support_ticket
  ADD CONSTRAINT support_ticket_contact_identity_check
  CHECK ("userId" IS NOT NULL OR (contact_name IS NOT NULL AND contact_email IS NOT NULL));
