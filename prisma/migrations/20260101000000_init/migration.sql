-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'TURBOREPO',
    "apps" TEXT NOT NULL DEFAULT '[]',
    "defaultApps" TEXT NOT NULL DEFAULT '[]',
    "defaultBaseBranch" TEXT NOT NULL DEFAULT 'main',
    "defaultSeed" TEXT,
    "sourceDatabaseUrl" TEXT,
    "dbEnvVarName" TEXT NOT NULL DEFAULT 'DATABASE_URL',
    "dbDockerImage" TEXT NOT NULL DEFAULT 'postgres:15-alpine',
    "devCommands" TEXT,
    "appPorts" TEXT,
    "linearApiKey" TEXT,
    "linearTeamId" TEXT,
    "linearProjectId" TEXT,
    "linearExcludeStates" TEXT NOT NULL DEFAULT '["Triage","Backlog"]',
    "linearFilterLabels" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "todo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "todo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL DEFAULT 'main',
    "worktreePath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "kind" TEXT NOT NULL DEFAULT 'FULL',
    "apps" TEXT NOT NULL DEFAULT '[]',
    "prNumber" INTEGER,
    "prTitle" TEXT,
    "prUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "environment_database" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "host" TEXT NOT NULL DEFAULT 'localhost',
    "user" TEXT NOT NULL DEFAULT 'postgres',
    "password" TEXT NOT NULL DEFAULT 'postgres',
    "url" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    CONSTRAINT "environment_database_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "port_allocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    CONSTRAINT "port_allocation_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "process_info" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "pid" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "port" INTEGER NOT NULL,
    CONSTRAINT "process_info_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "repo" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "devflow_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portRangeStart" INTEGER NOT NULL DEFAULT 3000,
    "portRangeSize" INTEGER NOT NULL DEFAULT 100,
    "dbDefaultPort" INTEGER NOT NULL DEFAULT 5432,
    "dbSeedStrategy" TEXT NOT NULL DEFAULT 'COPY_MAIN',
    "worktreeLocation" TEXT NOT NULL DEFAULT '.devflow/worktrees',
    "dockerNetwork" TEXT NOT NULL DEFAULT 'devflow',
    "dockerVolumePrefix" TEXT NOT NULL DEFAULT 'devflow',
    "activeEnvironmentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "project_name_key" ON "project"("name");

-- CreateIndex
CREATE UNIQUE INDEX "environment_name_key" ON "environment"("name");

-- CreateIndex
CREATE UNIQUE INDEX "environment_database_environmentId_key" ON "environment_database"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "port_allocation_port_key" ON "port_allocation"("port");

-- CreateIndex
CREATE UNIQUE INDEX "port_allocation_environmentId_appName_key" ON "port_allocation"("environmentId", "appName");

-- CreateIndex
CREATE UNIQUE INDEX "process_info_environmentId_appName_key" ON "process_info"("environmentId", "appName");

-- CreateIndex
CREATE UNIQUE INDEX "template_name_key" ON "template"("name");

