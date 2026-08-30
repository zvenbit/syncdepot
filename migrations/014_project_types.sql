ALTER TABLE games
  ADD COLUMN project_type varchar(32) NOT NULL DEFAULT 'game';

ALTER TABLE games
  ADD CONSTRAINT games_project_type_check
  CHECK (project_type IN ('game', 'app', 'mini_program', 'website', 'server', 'other'));
