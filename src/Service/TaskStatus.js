'use strict';

const TaskStatus = Object.freeze({
  Unknown: 'unknown',
  Enqueued: 'enqueued',
  Running: 'running',
  Finished: 'finished',
  Timeout: 'timeout',
});

module.exports = { TaskStatus };
