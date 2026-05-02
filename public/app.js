const state = {
  token: localStorage.getItem("flowboard.token"),
  user: null,
  users: [],
  projects: [],
  tasks: [],
  dashboard: null,
  authMode: "login"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function formatStatus(status) {
  return status.replace("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isOverdue(task) {
  const today = new Date().toISOString().slice(0, 10);
  return task.status !== "done" && task.dueDate < today;
}

function selectedValues(select) {
  return Array.from(select.selectedOptions).map((option) => option.value);
}

function setAuthMode(mode) {
  state.authMode = mode;
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  $$(".signup-only").forEach((item) => item.classList.toggle("hidden", mode !== "signup"));
  $("#auth-form").querySelector("button[type='submit']").textContent = mode === "signup" ? "Create account" : "Login";
  $("#auth-message").textContent = "";
}

function renderShell() {
  const authed = Boolean(state.user);
  $("#auth-view").classList.toggle("hidden", authed);
  $("#app-view").classList.toggle("hidden", !authed);
  if (!authed) return;
  $("#user-label").textContent = `${state.user.name} · ${state.user.role}`;
  $$(".admin-only").forEach((item) => item.classList.toggle("hidden", state.user.role !== "Admin"));
}

function renderMetrics() {
  const dashboard = state.dashboard;
  const metrics = [
    ["Projects", dashboard.projects],
    ["Total tasks", dashboard.totalTasks],
    ["Open for me", dashboard.myOpenTasks],
    ["Overdue", dashboard.overdue],
    ["Done", dashboard.byStatus.done || 0]
  ];
  $("#metrics").innerHTML = metrics.map(([label, value]) => `
    <article class="metric">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>
  `).join("");
}

function renderProjects() {
  const filter = $("#project-filter");
  filter.innerHTML = `<option value="">All projects</option>${state.projects.map((project) => `<option value="${project.id}">${project.name}</option>`).join("")}`;

  const projectSelect = $("#task-form [name='projectId']");
  projectSelect.innerHTML = state.projects.map((project) => `<option value="${project.id}">${project.name}</option>`).join("");

  const memberSelect = $("#project-form [name='memberIds']");
  memberSelect.innerHTML = state.users.map((user) => `<option value="${user.id}">${user.name} (${user.role})</option>`).join("");

  $("#project-list").innerHTML = state.projects.length ? state.projects.map((project) => `
    <article class="project-item">
      <h4>${escapeHtml(project.name)}</h4>
      <div class="project-meta">${escapeHtml(project.description || "No description")}</div>
      <div class="project-meta">${project.members.length} member${project.members.length === 1 ? "" : "s"}</div>
    </article>
  `).join("") : `<div class="empty">No projects yet.</div>`;

  renderAssigneeOptions();
}

function renderAssigneeOptions() {
  const projectId = $("#task-form [name='projectId']").value;
  const project = state.projects.find((item) => item.id === projectId);
  const members = project ? project.members : state.users;
  $("#task-form [name='assigneeId']").innerHTML = members.map((user) => `<option value="${user.id}">${user.name}</option>`).join("");
}

function renderTasks() {
  const projectId = $("#project-filter").value;
  const tasks = state.tasks.filter((task) => !projectId || task.projectId === projectId);
  $("#task-list").innerHTML = tasks.length ? tasks.map((task) => `
    <article class="task-card ${isOverdue(task) ? "overdue" : ""}">
      <div>
        <div class="task-title">
          <h4>${escapeHtml(task.title)}</h4>
          <span class="pill">${formatStatus(task.status)}</span>
          ${isOverdue(task) ? `<span class="pill warn">Overdue</span>` : ""}
        </div>
        <p class="task-meta">${escapeHtml(task.description || "No description")}</p>
        <div class="task-meta">
          ${escapeHtml(task.projectName)} · ${escapeHtml(task.assignee?.name || "Unassigned")} · Due ${task.dueDate}
        </div>
      </div>
      <div class="task-actions">
        <select data-task-status="${task.id}" aria-label="Update task status">
          ${["todo", "in_progress", "blocked", "done"].map((status) => `<option value="${status}" ${task.status === status ? "selected" : ""}>${formatStatus(status)}</option>`).join("")}
        </select>
      </div>
    </article>
  `).join("") : `<div class="empty">No tasks match this view.</div>`;

  $$("[data-task-status]").forEach((select) => {
    select.addEventListener("change", async () => {
      await request("/api/tasks", {
        method: "PATCH",
        body: JSON.stringify({ taskId: select.dataset.taskStatus, status: select.value })
      });
      await loadApp();
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

async function loadApp() {
  const [users, projects, tasks, dashboard] = await Promise.all([
    request("/api/users"),
    request("/api/projects"),
    request("/api/tasks"),
    request("/api/dashboard")
  ]);
  state.users = users.users;
  state.projects = projects.projects;
  state.tasks = tasks.tasks;
  state.dashboard = dashboard.dashboard;
  renderShell();
  renderMetrics();
  renderProjects();
  renderTasks();
}

async function bootstrap() {
  setAuthMode("login");
  if (!state.token) {
    renderShell();
    return;
  }
  try {
    const me = await request("/api/me");
    state.user = me.user;
    await loadApp();
  } catch {
    localStorage.removeItem("flowboard.token");
    state.token = null;
    renderShell();
  }
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.mode)));

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  $("#auth-message").textContent = "";
  try {
    const data = await request(`/api/auth/${state.authMode}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("flowboard.token", state.token);
    event.currentTarget.reset();
    await loadApp();
  } catch (error) {
    $("#auth-message").textContent = error.message;
  }
});

$("#logout-btn").addEventListener("click", () => {
  localStorage.removeItem("flowboard.token");
  state.token = null;
  state.user = null;
  renderShell();
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await request("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: form.name.value,
      description: form.description.value,
      memberIds: selectedValues(form.memberIds)
    })
  });
  form.reset();
  await loadApp();
});

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await request("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: form.projectId.value,
      title: form.title.value,
      assigneeId: form.assigneeId.value,
      dueDate: form.dueDate.value,
      description: form.description.value
    })
  });
  form.reset();
  await loadApp();
});

$("#task-form [name='projectId']").addEventListener("change", renderAssigneeOptions);
$("#project-filter").addEventListener("change", renderTasks);

bootstrap();
