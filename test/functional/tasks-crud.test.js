// Scenario 3: Tasks CRUD
// create task -> update status -> add comment -> close -> verify in list
//
// The tasks API routes shell out to `bd` CLI. We mock child_process.execSync
// with a stateful fake that tracks tasks across calls.

const request = require("supertest");
const { createFunctionalApp } = require("./helpers");

// Stateful bd CLI mock
function createBdMock() {
  const tasks = [];
  let nextNum = 100;

  function findTask(id) { return tasks.find(b => b.id === id); }

  return function mockExecSync(cmd, opts) {
    // bd list --json --allow-stale --all
    if (cmd.includes("bd list")) {
      return JSON.stringify(tasks);
    }

    // bd show <id> --json --allow-stale
    const showMatch = cmd.match(/bd show (\S+)/);
    if (showMatch) {
      const task = findTask(showMatch[1]);
      if (!task) throw new Error(`task ${showMatch[1]} not found`);
      return JSON.stringify(task);
    }

    // bd create "title" ...
    const createMatch = cmd.match(/bd create "([^"]+)"/);
    if (createMatch) {
      const id = `klaudii-t${nextNum++}`;
      const descMatch = cmd.match(/--description="([^"]+)"/);
      const prioMatch = cmd.match(/-p (\d)/);
      const typeMatch = cmd.match(/-t (\w+)/);
      const task = {
        id,
        title: createMatch[1],
        description: descMatch ? descMatch[1] : "",
        priority: prioMatch ? Number(prioMatch[1]) : 2,
        type: typeMatch ? typeMatch[1] : "task",
        status: "OPEN",
        assignee: null,
        comments: [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      tasks.push(task);
      return JSON.stringify(task);
    }

    // bd update <id> --status ... --json --allow-stale
    const updateMatch = cmd.match(/bd update (\S+)/);
    if (updateMatch) {
      const task = findTask(updateMatch[1]);
      if (!task) throw new Error(`task ${updateMatch[1]} not found`);
      const statusMatch = cmd.match(/--status (\w+)/);
      if (statusMatch) task.status = statusMatch[1].toUpperCase();
      const prioMatch = cmd.match(/-p (\d)/);
      if (prioMatch) task.priority = Number(prioMatch[1]);
      const assigneeMatch = cmd.match(/--assignee "([^"]+)"/);
      if (assigneeMatch) task.assignee = assigneeMatch[1];
      task.updated = new Date().toISOString();
      return JSON.stringify(task);
    }

    // bd comments add <id> "text" --allow-stale
    const commentMatch = cmd.match(/bd comments add (\S+) "([^"]+)"/);
    if (commentMatch) {
      const task = findTask(commentMatch[1]);
      if (!task) throw new Error(`task ${commentMatch[1]} not found`);
      task.comments.push({ text: commentMatch[2], ts: new Date().toISOString() });
      return "";
    }

    throw new Error(`Unrecognized bd command: ${cmd}`);
  };
}

describe("tasks CRUD", () => {
  let app, deps, cleanup, origExecSync;
  const execSync = require("child_process").execSync;

  beforeEach(() => {
    ({ app, deps, cleanup } = createFunctionalApp());

    // Intercept child_process.execSync for bd commands
    const bdMock = createBdMock();
    origExecSync = require("child_process").execSync;
    require("child_process").execSync = function(cmd, opts) {
      if (typeof cmd === "string" && cmd.startsWith("bd ")) {
        return bdMock(cmd, opts);
      }
      return origExecSync(cmd, opts);
    };
  });

  afterEach(() => {
    require("child_process").execSync = origExecSync;
    cleanup();
  });

  it("full CRUD: create -> list -> update -> comment -> verify", async () => {
    // 1. Create a task
    const createRes = await request(app)
      .post("/api/tasks")
      .send({ title: "Test task", description: "A functional test task", priority: 1, type: "bug" })
      .expect(201);
    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.title).toBe("Test task");
    expect(createRes.body.status).toBe("OPEN");
    const taskId = createRes.body.id;

    // 2. List tasks — should include our new one
    const listRes = await request(app).get("/api/tasks").expect(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.some(b => b.id === taskId)).toBe(true);

    // 3. Show individual task
    const showRes = await request(app).get(`/api/tasks/${taskId}`).expect(200);
    expect(showRes.body.id).toBe(taskId);
    expect(showRes.body.type).toBe("bug");

    // 4. Update status
    const updateRes = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ status: "in_progress" })
      .expect(200);
    expect(updateRes.body.status).toBe("IN_PROGRESS");

    // 5. Add a comment
    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ comment: "Working on this now" })
      .expect(200);

    // 6. Verify the comment is on the task
    const verifyRes = await request(app).get(`/api/tasks/${taskId}`).expect(200);
    expect(verifyRes.body.comments).toBeDefined();
    expect(verifyRes.body.comments.length).toBe(1);
    expect(verifyRes.body.comments[0].text).toBe("Working on this now");
  });

  it("create task requires title", async () => {
    await request(app)
      .post("/api/tasks")
      .send({ description: "no title" })
      .expect(400);
  });

  it("show task returns 404 for unknown id", async () => {
    await request(app)
      .get("/api/tasks/nonexistent-id")
      .expect(404);
  });

  it("rejects invalid task ID characters", async () => {
    await request(app)
      .get("/api/tasks/'; DROP TABLE tasks;--")
      .expect(400);
  });

  it("multiple tasks are tracked independently", async () => {
    await request(app)
      .post("/api/tasks")
      .send({ title: "Task A", priority: 0 })
      .expect(201);

    await request(app)
      .post("/api/tasks")
      .send({ title: "Task B", priority: 3 })
      .expect(201);

    const listRes = await request(app).get("/api/tasks").expect(200);
    expect(listRes.body.length).toBe(2);
    expect(listRes.body.map(b => b.title).sort()).toEqual(["Task A", "Task B"]);
  });
});
