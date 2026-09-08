#!/usr/bin/env node
// Thin launcher for the built CLI.
//
// DevFlow keeps its own state in ~/.devflow/devflow.db (or $DEVFLOW_HOME, or
// $XDG_DATA_HOME/devflow). The database location is resolved inside the
// program; nothing is read from a .env file here, so running devflow from
// inside a project never picks that project's DATABASE_URL by accident.
import "../dist/index.js";
