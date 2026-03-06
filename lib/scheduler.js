// Scheduler — manages named periodic tasks.
//
// Usage:
//   const scheduler = require('./lib/scheduler');
//   scheduler.register('shepherd', 5 * 60 * 1000, () => require('./lib/shepherd').run());
//   scheduler.start();

const tasks = new Map();

function register(name, intervalMs, handler) {
  if (tasks.has(name)) {
    throw new Error(`Task "${name}" is already registered`);
  }
  tasks.set(name, {
    name,
    intervalMs,
    handler,
    enabled: true,
    timerId: null,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    running: false,
  });
}

async function runTask(task) {
  if (task.running) {
    console.log(`[scheduler] skipping "${task.name}" — still running from previous invocation`);
    return;
  }
  task.running = true;
  const start = Date.now();
  try {
    const result = await task.handler();
    task.lastResult = result !== undefined ? result : "ok";
    task.lastError = null;
    console.log(`[scheduler] "${task.name}" completed in ${Date.now() - start}ms`);
  } catch (err) {
    task.lastError = err.message;
    task.lastResult = null;
    console.error(`[scheduler] "${task.name}" failed:`, err.message);
  } finally {
    task.lastRunAt = new Date().toISOString();
    task.running = false;
  }
}

function startTask(task) {
  if (task.timerId) return;
  task.timerId = setInterval(() => {
    if (task.enabled) runTask(task);
  }, task.intervalMs);
  // Don't run immediately on start — let the server finish booting first.
  // Use trigger() for an immediate run if needed.
}

function start() {
  for (const task of tasks.values()) {
    if (task.enabled) startTask(task);
  }
  console.log(`[scheduler] started ${tasks.size} task(s): ${[...tasks.keys()].join(", ")}`);
}

function stop() {
  for (const task of tasks.values()) {
    if (task.timerId) {
      clearInterval(task.timerId);
      task.timerId = null;
    }
  }
}

function pause(name) {
  const task = tasks.get(name);
  if (!task) return false;
  task.enabled = false;
  if (task.timerId) {
    clearInterval(task.timerId);
    task.timerId = null;
  }
  console.log(`[scheduler] paused "${name}"`);
  return true;
}

function resume(name) {
  const task = tasks.get(name);
  if (!task) return false;
  task.enabled = true;
  startTask(task);
  console.log(`[scheduler] resumed "${name}"`);
  return true;
}

async function trigger(name) {
  const task = tasks.get(name);
  if (!task) return null;
  await runTask(task);
  return { lastRunAt: task.lastRunAt, lastResult: task.lastResult, lastError: task.lastError };
}

function list() {
  return [...tasks.values()].map((t) => ({
    name: t.name,
    intervalMs: t.intervalMs,
    enabled: t.enabled,
    running: t.running,
    lastRunAt: t.lastRunAt,
    lastResult: t.lastResult,
    lastError: t.lastError,
  }));
}

module.exports = { register, start, stop, pause, resume, trigger, list };
