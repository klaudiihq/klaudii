// v1 API Response Shape Validators
//
// Derived directly from the iOS app's Swift Codable structs:
//   iOS/Klaudii/Models/Session.swift     → Session, GitStatus, GitFile, TtydInfo, ProcessInfo
//   iOS/Klaudii/Models/HistoryEntry.swift → HistoryEntry
//   iOS/Klaudii/Models/Server.swift       → Server, AuthUser
//
// Contract rule: fields can be ADDED but never REMOVED or TYPE-CHANGED.
// Must maintain compatibility for at least 3 API generations (v1, v2, v3).

/**
 * Assert that an object conforms to a v1 schema.
 * - Required fields must be present and non-null with correct type.
 * - Optional fields may be absent, null, or the expected type.
 * - Extra fields are always allowed (additive changes are safe for Codable).
 */
function assertShape(obj, schema, path = "") {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error(`${path || "root"}: expected object, got ${obj === null ? "null" : typeof obj}`);
  }

  for (const [field, spec] of Object.entries(schema)) {
    const fullPath = path ? `${path}.${field}` : field;
    const value = obj[field];

    if (spec.required && (value === undefined || value === null)) {
      throw new Error(`${fullPath}: required field is ${value === undefined ? "missing" : "null"}`);
    }

    if (value === undefined || value === null) {
      continue; // optional field absent or null
    }

    if (spec.type === "array") {
      if (!Array.isArray(value)) {
        throw new Error(`${fullPath}: expected array, got ${typeof value}`);
      }
      if (spec.items) {
        for (let i = 0; i < value.length; i++) {
          assertShape(value[i], spec.items, `${fullPath}[${i}]`);
        }
      }
    } else if (spec.type === "object") {
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${fullPath}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
      }
      if (spec.shape) {
        assertShape(value, spec.shape, fullPath);
      }
    } else if (spec.type === "number") {
      if (typeof value !== "number") {
        throw new Error(`${fullPath}: expected number, got ${typeof value}`);
      }
    } else if (spec.type === "string") {
      if (typeof value !== "string") {
        throw new Error(`${fullPath}: expected string, got ${typeof value}`);
      }
    } else if (spec.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`${fullPath}: expected boolean, got ${typeof value}`);
      }
    } else if (spec.type === "int") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${fullPath}: expected integer, got ${typeof value} (${value})`);
      }
    }
  }
}

/**
 * Assert that an array contains items matching a schema.
 */
function assertArrayOf(arr, schema, path = "array") {
  if (!Array.isArray(arr)) {
    throw new Error(`${path}: expected array, got ${typeof arr}`);
  }
  for (let i = 0; i < arr.length; i++) {
    assertShape(arr[i], schema, `${path}[${i}]`);
  }
}

// --- Schema definitions (mirror iOS Codable structs) ---

const GitFile = {
  status: { type: "string", required: true },
  path: { type: "string", required: true },
};

const GitStatus = {
  branch: { type: "string", required: false },
  dirtyFiles: { type: "number", required: false },
  unpushed: { type: "number", required: false },
  files: { type: "array", required: false, items: GitFile },
};

const TtydInfo = {
  project: { type: "string", required: false },
  port: { type: "number", required: false },
  pid: { type: "number", required: false },
};

// Session.swift:3-16
const Session = {
  project: { type: "string", required: true },
  projectPath: { type: "string", required: true },
  permissionMode: { type: "string", required: true },
  running: { type: "boolean", required: true },
  status: { type: "string", required: true },
  claudeUrl: { type: "string", required: false },
  git: { type: "object", required: false, shape: GitStatus },
  remoteUrl: { type: "string", required: false },
  sessionCount: { type: "number", required: true },
  lastActivity: { type: "number", required: false },
  ttyd: { type: "object", required: false, shape: TtydInfo },
};

// Session.swift:67-81
const ProcessInfo = {
  pid: { type: "int", required: true },
  ppid: { type: "number", required: false },
  cwd: { type: "string", required: false },
  project: { type: "string", required: false },
  type: { type: "string", required: false },
  managed: { type: "boolean", required: true },
  uptime: { type: "string", required: false },
  cpu: { type: "number", required: false },
  memMB: { type: "number", required: false },
  launchedBy: { type: "string", required: false },
  command: { type: "string", required: false },
};

// HistoryEntry.swift:3-8
const HistoryEntry = {
  sessionId: { type: "string", required: true },
  timestamp: { type: "number", required: true },
  display: { type: "string", required: true },
};

// Server.swift:3-9
const Server = {
  id: { type: "string", required: true },
  name: { type: "string", required: true },
  online: { type: "boolean", required: true },
  platform: { type: "string", required: false },
  lastSeen: { type: "number", required: false },
  createdAt: { type: "number", required: false },
};

// Server.swift:20-24
const AuthUser = {
  id: { type: "string", required: true },
  email: { type: "string", required: true },
  name: { type: "string", required: false },
};

// GET /api/health
const Health = {
  ok: { type: "boolean", required: true },
  tmux: { type: "boolean", required: true },
  ttyd: { type: "boolean", required: true },
};

// Standard POST success
const OkResponse = {
  ok: { type: "boolean", required: true },
};

// POST /api/projects/permission
const PermissionResponse = {
  ok: { type: "boolean", required: true },
  mode: { type: "string", required: true },
};

// POST /api/sessions/start, /api/sessions/restart
const SessionStartResponse = {
  ok: { type: "boolean", required: true },
  tmuxSession: { type: "string", required: true },
  ttydPort: { type: "number", required: true },
};

// POST /api/sessions/new
const NewSessionResponse = {
  ok: { type: "boolean", required: true },
  project: { type: "string", required: true },
  worktree: { type: "string", required: true },
  branch: { type: "string", required: true },
  tmuxSession: { type: "string", required: true },
  ttydPort: { type: "number", required: true },
};

// POST /api/repos/create
const RepoCreateResponse = {
  ok: { type: "boolean", required: true },
  name: { type: "string", required: true },
  path: { type: "string", required: true },
};

// GET /api/github/repos
const GitHubRepo = {
  name: { type: "string", required: true },
  owner: { type: "string", required: true },
  sshUrl: { type: "string", required: true },
  cloned: { type: "boolean", required: true },
};

// GET /api/relay/health
const RelayHealth = {
  ok: { type: "boolean", required: true },
  onlineServers: { type: "number", required: true },
};

// POST /api/pairing/create
const PairingCreateResponse = {
  code: { type: "string", required: true },
  expiresIn: { type: "number", required: true },
};

// POST /api/pairing/redeem
const PairingRedeemResponse = {
  serverId: { type: "string", required: true },
  relayUrl: { type: "string", required: true },
};

module.exports = {
  assertShape,
  assertArrayOf,
  schemas: {
    Session,
    GitStatus,
    GitFile,
    TtydInfo,
    ProcessInfo,
    HistoryEntry,
    Server,
    AuthUser,
    Health,
    OkResponse,
    PermissionResponse,
    SessionStartResponse,
    NewSessionResponse,
    RepoCreateResponse,
    GitHubRepo,
    RelayHealth,
    PairingCreateResponse,
    PairingRedeemResponse,
  },
};
