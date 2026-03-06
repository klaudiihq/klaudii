// Scenario 3: Beads CRUD
// create bead -> update status -> add comment -> close -> verify in list
//
// The beads API routes shell out to `bd` CLI. We mock child_process.execSync
// with a stateful fake that tracks beads across calls.

const request = require("supertest");
const { createFunctionalApp } = require("./helpers");

// Stateful bd CLI mock
function createBdMock() {
  const beads = [];
  let nextNum = 100;

  function findBead(id) { return beads.find(b => b.id === id); }

  return function mockExecSync(cmd, opts) {
    // bd list --json --allow-stale --all
    if (cmd.includes("bd list")) {
      return JSON.stringify(beads);
    }

    // bd show <id> --json --allow-stale
    const showMatch = cmd.match(/bd show (\S+)/);
    if (showMatch) {
      const bead = findBead(showMatch[1]);
      if (!bead) throw new Error(`bead ${showMatch[1]} not found`);
      return JSON.stringify(bead);
    }

    // bd create "title" ...
    const createMatch = cmd.match(/bd create "([^"]+)"/);
    if (createMatch) {
      const id = `klaudii-t${nextNum++}`;
      const descMatch = cmd.match(/--description="([^"]+)"/);
      const prioMatch = cmd.match(/-p (\d)/);
      const typeMatch = cmd.match(/-t (\w+)/);
      const bead = {
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
      beads.push(bead);
      return JSON.stringify(bead);
    }

    // bd update <id> --status ... --json --allow-stale
    const updateMatch = cmd.match(/bd update (\S+)/);
    if (updateMatch) {
      const bead = findBead(updateMatch[1]);
      if (!bead) throw new Error(`bead ${updateMatch[1]} not found`);
      const statusMatch = cmd.match(/--status (\w+)/);
      if (statusMatch) bead.status = statusMatch[1].toUpperCase();
      const prioMatch = cmd.match(/-p (\d)/);
      if (prioMatch) bead.priority = Number(prioMatch[1]);
      const assigneeMatch = cmd.match(/--assignee "([^"]+)"/);
      if (assigneeMatch) bead.assignee = assigneeMatch[1];
      bead.updated = new Date().toISOString();
      return JSON.stringify(bead);
    }

    // bd comment <id> "text" --allow-stale
    const commentMatch = cmd.match(/bd comment (\S+) "([^"]+)"/);
    if (commentMatch) {
      const bead = findBead(commentMatch[1]);
      if (!bead) throw new Error(`bead ${commentMatch[1]} not found`);
      bead.comments.push({ text: commentMatch[2], ts: new Date().toISOString() });
      return "";
    }

    throw new Error(`Unrecognized bd command: ${cmd}`);
  };
}

describe("beads CRUD", () => {
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
    // 1. Create a bead
    const createRes = await request(app)
      .post("/api/beads")
      .send({ title: "Test bead", description: "A functional test bead", priority: 1, type: "bug" })
      .expect(201);
    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.title).toBe("Test bead");
    expect(createRes.body.status).toBe("OPEN");
    const beadId = createRes.body.id;

    // 2. List beads — should include our new one
    const listRes = await request(app).get("/api/beads").expect(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.some(b => b.id === beadId)).toBe(true);

    // 3. Show individual bead
    const showRes = await request(app).get(`/api/beads/${beadId}`).expect(200);
    expect(showRes.body.id).toBe(beadId);
    expect(showRes.body.type).toBe("bug");

    // 4. Update status
    const updateRes = await request(app)
      .patch(`/api/beads/${beadId}`)
      .send({ status: "in_progress" })
      .expect(200);
    expect(updateRes.body.status).toBe("IN_PROGRESS");

    // 5. Add a comment
    await request(app)
      .patch(`/api/beads/${beadId}`)
      .send({ comment: "Working on this now" })
      .expect(200);

    // 6. Verify the comment is on the bead
    const verifyRes = await request(app).get(`/api/beads/${beadId}`).expect(200);
    expect(verifyRes.body.comments).toBeDefined();
    expect(verifyRes.body.comments.length).toBe(1);
    expect(verifyRes.body.comments[0].text).toBe("Working on this now");
  });

  it("create bead requires title", async () => {
    await request(app)
      .post("/api/beads")
      .send({ description: "no title" })
      .expect(400);
  });

  it("show bead returns 404 for unknown id", async () => {
    await request(app)
      .get("/api/beads/nonexistent-id")
      .expect(404);
  });

  it("rejects invalid bead ID characters", async () => {
    await request(app)
      .get("/api/beads/'; DROP TABLE beads;--")
      .expect(400);
  });

  it("multiple beads are tracked independently", async () => {
    await request(app)
      .post("/api/beads")
      .send({ title: "Bead A", priority: 0 })
      .expect(201);

    await request(app)
      .post("/api/beads")
      .send({ title: "Bead B", priority: 3 })
      .expect(201);

    const listRes = await request(app).get("/api/beads").expect(200);
    expect(listRes.body.length).toBe(2);
    expect(listRes.body.map(b => b.title).sort()).toEqual(["Bead A", "Bead B"]);
  });
});
