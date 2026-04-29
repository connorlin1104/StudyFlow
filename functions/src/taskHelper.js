'use strict';
const { CloudTasksClient } = require('@google-cloud/tasks');
const { db } = require('./firebaseAdmin');

const LOCATION = 'us-central1';
const QUEUE    = 'notifications';
const API_URL  = 'https://api-5em2zrdv2a-uc.a.run.app';

function computeRemindAt(deadline, deadlineTime, remindMins, deadlineMs) {
  const base = deadlineMs ?? (() => {
    const timeStr = deadlineTime || '23:59';
    const [hh, mm] = timeStr.split(':').map(Number);
    const [y, mo, d] = deadline.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, d, hh, mm)).getTime();
  })();
  return base - remindMins * 60 * 1000;
}

async function cancelTask(taskName) {
  if (!taskName) return;
  try {
    await new CloudTasksClient().deleteTask({ name: taskName });
  } catch (_) {} // already executed or never existed
}

// item = { deadline, deadlineTime, remindBefore, notifyTaskName }
async function scheduleNotification(uid, hwId, item) {
  await cancelTask(item.notifyTaskName);

  if (!item.deadline) return null;
  if (item.remindBefore === -1) return null;

  let remindMins = item.remindBefore;
  if (remindMins == null) {
    const snap = await db.collection('pushSubscriptions').where('uid', '==', uid).limit(1).get();
    remindMins = snap.empty ? 60 : (snap.docs[0].data().notifyBefore ?? 60);
  }

  const remindAt = computeRemindAt(item.deadline, item.deadlineTime, remindMins, item.deadlineMs);
  console.log(`scheduleNotification: hwId=${hwId} remindAt=${new Date(remindAt).toISOString()} now=${new Date().toISOString()} remindMins=${remindMins}`);
  if (remindAt <= Date.now() + 30000) {
    console.log('scheduleNotification: skipped (remindAt too soon or in past)');
    return null;
  }

  try {
    const client = new CloudTasksClient();
    const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    const parent  = client.queuePath(project, LOCATION, QUEUE);
    const [task]  = await client.createTask({
      parent,
      task: {
        scheduleTime: { seconds: Math.floor(remindAt / 1000) },
        httpRequest: {
          httpMethod: 'POST',
          url: `${API_URL}/internal/notify`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ uid, hwId })).toString('base64'),
        },
      },
    });
    console.log(`scheduleNotification: task created ${task.name}`);
    return task.name;
  } catch (err) {
    console.error('scheduleNotification failed:', err.message);
    return null;
  }
}

module.exports = { scheduleNotification, cancelTask };
