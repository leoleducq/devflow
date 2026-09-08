-- The Todo model came from the desktop app, which had a todos page. The CLI
-- has no use for a project-scoped checklist — coding agents track their own
-- work, and a todo has no relationship to an environment — so the table goes
-- rather than sit unread in every user's database.
DROP TABLE IF EXISTS "todo";
