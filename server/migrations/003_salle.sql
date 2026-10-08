-- Étape 4 : la salle SOS se termine par « Problème résolu » ; le code est effacé à ce moment-là.
ALTER TABLE requests DROP CONSTRAINT requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check CHECK (status IN ('ouverte', 'acceptee', 'resolue', 'fermee'));
ALTER TABLE requests ADD COLUMN resolved_at timestamptz;
