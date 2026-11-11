-- Positionings are referenced "POS 001/2026", not "PO 001/2026".
UPDATE "documents"
SET "reference" = 'POS' || substring("reference" from 3)
WHERE "reference" ~ '^PO [0-9]+/[0-9]{4}$';
