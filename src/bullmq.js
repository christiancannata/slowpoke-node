'use strict';

const slowpoke = require('./index');

/**
 * One trace per job a BullMQ worker runs, with its queue and whether it threw:
 *
 *     new Worker('emails', slowpoke.bullmq.processor(async (job) => { ... }))
 *
 * The queries inside keep their file:line, and the job lands on the Jobs page, not among the
 * endpoints. A job is traced where it runs, never where it was added.
 */
function processor(fn) {
  return function slowpokeProcessor(job, token) {
    const queue = job && (job.queueName || (job.queue && job.queue.name));
    return slowpoke.job(jobName(job, queue), () => fn(job, token), { queue });
  };
}

/**
 * The job's name, or its queue's when it has none: Bull 3 calls a job added without a name
 * "__default__". Never the id, which is different for every run (a repeatable job's is
 * "repeat:<key>:<timestamp>"): each run would become a Jobs page row of its own.
 */
function jobName(job, queue) {
  const name = job && typeof job.name === 'string' ? job.name.trim() : '';
  if (name !== '' && name !== '__default__') return name;
  return (typeof queue === 'string' && queue.trim()) || 'job';
}

module.exports = { processor, jobName };
