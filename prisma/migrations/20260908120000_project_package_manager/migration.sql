-- DevFlow used to shell out to pnpm unconditionally, which made an npm, yarn
-- or bun repo unusable. A project now records which manager it uses. NULL
-- keeps the old behaviour of working it out from the checkout (the
-- packageManager field, then the lock file, then npm).
ALTER TABLE "project" ADD COLUMN "packageManager" TEXT;
