const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const TOKEN_SECRET = process.env.TOKEN_SECRET || "dev-secret-change-me";
const TASK_STATUSES = new Set(["todo", "in_progress", "blocked", "done"]);

let db = {
  users: [],
  projects: [],
  tasks: [],
  sessions: []
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

function publicProject(project) {
  return {
    ...project,
    members: project.members.map((memberId) => publicUser(db.users.find((user) => user.id === memberId))).filter(Boolean)
  };
}

function publicTask(task) {
  const project = db.projects.find((item) => item.id === task.projectId);
  return {
    ...task,
    projectName: project?.name || "Unknown project",
    assignee: publicUser(db.users.find((user) => user.id === task.assigneeId))
  };
}

async function ensureDb() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    db = JSON.parse(raw);
    db.sessions = db.sessions || [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveDb();
  }
}

async function saveDb() {
  await fs.writeFile(DATA_FILE, `${JSON.stringify(db, null, 2)}\n`);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

function signToken(userId) {
  const sessionId = id("ses");
  const payload = Buffer.from(JSON.stringify({ userId, sessionId, iat: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  db.sessions.push({ id: sessionId, userId, createdAt: now() });
  return `${payload}.${signature}`;
}

function readToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const session = db.sessions.find((item) => item.id === decoded.sessionId && item.userId === decoded.userId);
    if (!session) return null;
    return db.users.find((user) => user.id === decoded.userId) || null;
  } catch {
    return null;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireAuth(req) {
  const user = readToken(req);
  if (!user) throw httpError(401, "Login required.");
  return user;
}

function requireAdmin(user) {
  if (user.role !== "Admin") throw httpError(403, "Admin access required.");
}

function canAccessProject(user, project) {
  return user.role === "Admin" || project.members.includes(user.id);
}

function canAccessTask(user, task) {
  const project = db.projects.find((item) => item.id === task.projectId);
  return user.role === "Admin" || task.assigneeId === user.id || project?.members.includes(user.id);
}

function validateString(value, field, min = 1, max = 120) {
  const text = String(value || "").trim();
  if (text.length < min) throw httpError(400, `${field} is required.`);
  if (text.length > max) throw httpError(400, `${field} must be ${max} characters or less.`);
  return text;
}

function validateDate(value, field) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(400, `${field} must use YYYY-MM-DD format.`);
  if (Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw httpError(400, `${field} is invalid.`);
  return text;
}

function routeKey(method, pathname) {
  return `${method} ${pathname}`;
}

async function api(req, res, pathname) {
  const method = req.method;
  const key = routeKey(method, pathname);

  if (key === "POST /api/auth/signup") {
    const body = await readJson(req);
    const name = validateString(body.name, "Name", 2, 80);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "A valid email is required.");
    if (password.length < 8) throw httpError(400, "Password must be at least 8 characters.");
    if (db.users.some((user) => user.email === email)) throw httpError(409, "Email is already registered.");

    const role = db.users.length === 0 ? "Admin" : "Member";
    const user = { id: id("usr"), name, email, role, passwordHash: hashPassword(password), createdAt: now() };
    db.users.push(user);
    const token = signToken(user.id);
    await saveDb();
    return sendJson(res, 201, { token, user: publicUser(user) });
  }

  if (key === "POST /api/auth/login") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const user = db.users.find((item) => item.email === email);
    if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) {
      throw httpError(401, "Invalid email or password.");
    }
    const token = signToken(user.id);
    await saveDb();
    return sendJson(res, 200, { token, user: publicUser(user) });
  }

  if (key === "GET /api/me") {
    const user = requireAuth(req);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (key === "GET /api/users") {
    const user = requireAuth(req);
    const visibleUsers = user.role === "Admin"
      ? db.users
      : db.users.filter((candidate) => candidate.id === user.id || db.projects.some((project) => project.members.includes(user.id) && project.members.includes(candidate.id)));
    return sendJson(res, 200, { users: visibleUsers.map(publicUser) });
  }

  if (key === "PATCH /api/users/role") {
    const user = requireAuth(req);
    requireAdmin(user);
    const body = await readJson(req);
    const target = db.users.find((item) => item.id === body.userId);
    if (!target) throw httpError(404, "User not found.");
    if (!["Admin", "Member"].includes(body.role)) throw httpError(400, "Role must be Admin or Member.");
    if (target.id === user.id && body.role !== "Admin") throw httpError(400, "You cannot demote your own admin account.");
    target.role = body.role;
    await saveDb();
    return sendJson(res, 200, { user: publicUser(target) });
  }

  if (key === "GET /api/projects") {
    const user = requireAuth(req);
    const projects = db.projects.filter((project) => canAccessProject(user, project)).map(publicProject);
    return sendJson(res, 200, { projects });
  }

  if (key === "POST /api/projects") {
    const user = requireAuth(req);
    requireAdmin(user);
    const body = await readJson(req);
    const name = validateString(body.name, "Project name", 2, 100);
    const description = String(body.description || "").trim().slice(0, 500);
    const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
    const members = [...new Set([user.id, ...memberIds])].filter((memberId) => db.users.some((item) => item.id === memberId));
    const project = { id: id("prj"), name, description, ownerId: user.id, members, createdAt: now(), updatedAt: now() };
    db.projects.push(project);
    await saveDb();
    return sendJson(res, 201, { project: publicProject(project) });
  }

  if (key === "PATCH /api/projects") {
    const user = requireAuth(req);
    requireAdmin(user);
    const body = await readJson(req);
    const project = db.projects.find((item) => item.id === body.projectId);
    if (!project) throw httpError(404, "Project not found.");
    if (body.name !== undefined) project.name = validateString(body.name, "Project name", 2, 100);
    if (body.description !== undefined) project.description = String(body.description || "").trim().slice(0, 500);
    if (Array.isArray(body.memberIds)) {
      project.members = [...new Set([project.ownerId, ...body.memberIds])].filter((memberId) => db.users.some((item) => item.id === memberId));
    }
    project.updatedAt = now();
    await saveDb();
    return sendJson(res, 200, { project: publicProject(project) });
  }

  if (key === "GET /api/tasks") {
    const user = requireAuth(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const projectId = url.searchParams.get("projectId");
    let tasks = db.tasks.filter((task) => canAccessTask(user, task));
    if (projectId) tasks = tasks.filter((task) => task.projectId === projectId);
    return sendJson(res, 200, { tasks: tasks.map(publicTask) });
  }

  if (key === "POST /api/tasks") {
    const user = requireAuth(req);
    requireAdmin(user);
    const body = await readJson(req);
    const project = db.projects.find((item) => item.id === body.projectId);
    if (!project) throw httpError(404, "Project not found.");
    const assignee = db.users.find((item) => item.id === body.assigneeId);
    if (!assignee) throw httpError(404, "Assignee not found.");
    if (!project.members.includes(assignee.id)) throw httpError(400, "Assignee must be a project member.");
    const title = validateString(body.title, "Task title", 2, 140);
    const dueDate = validateDate(body.dueDate, "Due date");
    const task = {
      id: id("tsk"),
      projectId: project.id,
      title,
      description: String(body.description || "").trim().slice(0, 800),
      assigneeId: assignee.id,
      status: TASK_STATUSES.has(body.status) ? body.status : "todo",
      dueDate,
      createdBy: user.id,
      createdAt: now(),
      updatedAt: now()
    };
    db.tasks.push(task);
    await saveDb();
    return sendJson(res, 201, { task: publicTask(task) });
  }

  if (key === "PATCH /api/tasks") {
    const user = requireAuth(req);
    const body = await readJson(req);
    const task = db.tasks.find((item) => item.id === body.taskId);
    if (!task) throw httpError(404, "Task not found.");
    if (!canAccessTask(user, task)) throw httpError(403, "You cannot access this task.");
    const isAdmin = user.role === "Admin";
    if (!isAdmin && Object.keys(body).some((field) => !["taskId", "status"].includes(field))) {
      throw httpError(403, "Members can only update task status.");
    }
    if (body.title !== undefined) task.title = validateString(body.title, "Task title", 2, 140);
    if (body.description !== undefined) task.description = String(body.description || "").trim().slice(0, 800);
    if (body.status !== undefined) {
      if (!TASK_STATUSES.has(body.status)) throw httpError(400, "Invalid task status.");
      task.status = body.status;
    }
    if (body.dueDate !== undefined) task.dueDate = validateDate(body.dueDate, "Due date");
    if (body.assigneeId !== undefined) {
      const project = db.projects.find((item) => item.id === task.projectId);
      const assignee = db.users.find((item) => item.id === body.assigneeId);
      if (!assignee) throw httpError(404, "Assignee not found.");
      if (!project.members.includes(assignee.id)) throw httpError(400, "Assignee must be a project member.");
      task.assigneeId = assignee.id;
    }
    task.updatedAt = now();
    await saveDb();
    return sendJson(res, 200, { task: publicTask(task) });
  }

  if (key === "GET /api/dashboard") {
    const user = requireAuth(req);
    const visibleTasks = db.tasks.filter((task) => canAccessTask(user, task));
    const byStatus = [...TASK_STATUSES].reduce((acc, status) => ({ ...acc, [status]: visibleTasks.filter((task) => task.status === status).length }), {});
    const overdue = visibleTasks.filter((task) => task.status !== "done" && task.dueDate < todayISO());
    const mine = visibleTasks.filter((task) => task.assigneeId === user.id && task.status !== "done");
    return sendJson(res, 200, {
      dashboard: {
        projects: db.projects.filter((project) => canAccessProject(user, project)).length,
        totalTasks: visibleTasks.length,
        byStatus,
        overdue: overdue.length,
        myOpenTasks: mine.length,
        overdueTasks: overdue.map(publicTask),
        upcomingTasks: visibleTasks
          .filter((task) => task.status !== "done")
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .slice(0, 8)
          .map(publicTask)
      }
    });
  }

  throw httpError(404, "API route not found.");
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) throw httpError(403, "Forbidden.");
  try {
    const file = await fs.readFile(filePath);
    const type = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      const fallback = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fallback);
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await api(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Server error." });
  }
});

ensureDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Project task app running on http://localhost:${PORT}`);
  });
});
