'use strict';
const debug = require('debug')('agenda:internal:_findAndLockNextJob');
const {createJob} = require('../utils');

/**
 * Find and lock jobs
 * @name Agenda#findAndLockNextJob
 * @function
 * @param {String} jobName name of job to try to lock
 * @param {Object} definition definition used to tell how job is run
 * @access protected
 * @caller jobQueueFilling() only
 * @returns Promise
 */
module.exports = async function(jobName, definition) {
  const self = this;
  const now = new Date();
  const lockDeadline = new Date(Date.now().valueOf() - definition.lockLifetime);
  debug('_findAndLockNextJob(%s, [Function])', jobName);

  // Don't try and access MongoDB if we've lost connection to it.
  // Trying to resolve crash on Dev PC when it resumes from sleep. NOTE: Does this still happen?
  const s = this._mdb.s || this._mdb.db.s;
  if (s.topology.connections && s.topology.connections().length === 0 && !this._mongoUseUnifiedTopology) {
    if (s.topology.autoReconnect && !s.topology.isDestroyed()) {
      // Continue processing but notify that Agenda has lost the connection
      debug('Missing MongoDB connection, not attempting to find and lock a job');
      self.emit('error', new Error('Lost MongoDB connection'));
    } else {
      // No longer recoverable
      debug('topology.autoReconnect: %s, topology.isDestroyed(): %s', s.topology.autoReconnect, s.topology.isDestroyed());
      throw new Error('MongoDB connection is not recoverable, application restart required');
    }
  } else {

    const JOB_PROCESS_WHERE_QUERY_BY_NEXT_RUN_AT = {
      name: jobName,
      lockedAt: null,
      nextRunAt: { $lte: this._nextScanAt },
      disabled: { $ne: true },
    };

    const JOB_PROCESS_WHERE_QUERY_BY_LOCKED_AT = {
      name: jobName,
      lockedAt: { $lte: lockDeadline },
      disabled: { $ne: true },
    };

    // /**
    // * Query used to find job to run
    // * @type {{$and: [*]}}
    // */
    const JOB_PROCESS_WHERE_QUERY = {
      $or: [JOB_PROCESS_WHERE_QUERY_BY_NEXT_RUN_AT, JOB_PROCESS_WHERE_QUERY_BY_LOCKED_AT]
    };

    /**
     * Query used to set a job as locked
     * @type {{$set: {lockedAt: Date}}}
     */
    const JOB_PROCESS_SET_QUERY = {$set: {lockedAt: now}};

    /**
     * Query used to affect what gets returned
     * @type {{returnOriginal: boolean, sort: object}}
     */
    const JOB_RETURN_QUERY = {returnOriginal: false, sort: this._sort};

    let result;

    if (process.env.AGENDA_FIND_JOBS_TWO_STEPS && process.env.AGENDA_FIND_JOBS_TWO_STEPS === 'true') {
      result = await this._collection.findOneAndUpdate(JOB_PROCESS_WHERE_QUERY_BY_LOCKED_AT, JOB_PROCESS_SET_QUERY, JOB_RETURN_QUERY);
      if (!result.value) {
        result = await this._collection.findOneAndUpdate(JOB_PROCESS_WHERE_QUERY_BY_NEXT_RUN_AT, JOB_PROCESS_SET_QUERY, JOB_RETURN_QUERY);
      }
    } else {
      // Find ONE and ONLY ONE job and set the 'lockedAt' time so that job begins to be processed
      result = await this._collection.findOneAndUpdate(JOB_PROCESS_WHERE_QUERY, JOB_PROCESS_SET_QUERY, JOB_RETURN_QUERY);
    }

    let job;
    if (result.value) {
      debug('found a job available to lock, creating a new job on Agenda with id [%s]', result.value._id);
      job = createJob(self, result.value);
    }

    return job;
  }
};
