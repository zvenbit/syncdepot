ALTER TABLE admins ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
