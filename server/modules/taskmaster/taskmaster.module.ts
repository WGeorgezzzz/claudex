import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';

import express from 'express';

import { projectsDb } from '@/modules/database/index.js';

import { createTaskmasterNativeRouter } from './taskmaster-native.routes.js';
import { createTaskmasterRouter } from './taskmaster.routes.js';
import { createTaskmasterService } from './taskmaster.service.js';

const taskmasterService = createTaskmasterService({
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  getHomeDirectory: os.homedir,
});

/** Used by the server entrypoint to mount authenticated TaskMaster endpoints. */
const legacyRoutes = createTaskmasterRouter({
  fileSystem: fs,
  fileSystemPromises: fsPromises,
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  taskmasterService,
});

/** Server mounts native operations before legacy document reads. */
export const taskmasterRoutes = express.Router().use(createTaskmasterNativeRouter()).use(legacyRoutes);
