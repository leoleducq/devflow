-- Opt-in portless integration: when on, DevFlow registers a named HTTPS route
-- per app of the project's environments and writes those URLs into the
-- generated .env files instead of localhost:<port>.
--
-- Additive with a default, so an existing database keeps every project on the
-- plain-port behaviour it has today.
ALTER TABLE "project" ADD COLUMN "portless" BOOLEAN NOT NULL DEFAULT false;
