# FlowBoard

FlowBoard is a full-stack project and task management web app with authentication, project teams, task assignment, dashboard tracking, validations, persisted data, and role-based access control.

## Features

- Signup and login with secure password hashing.
- First signup becomes `Admin`; later signups become `Member`.
- Admins can create projects, add team members, create tasks, and assign tasks.
- Members can view projects they belong to and update task status.
- Dashboard shows project count, total tasks, user open tasks, overdue tasks, and completed tasks.
- REST API backed by a file-based document database at `data/db.json`.
- Railway-ready with `railway.json` and `npm start`.

## Tech Stack

- Node.js HTTP server with no external runtime dependencies.
- Vanilla HTML, CSS, and JavaScript frontend.
- File-backed NoSQL-style document database.
- Token-based authentication with HMAC-signed sessions.

## Local Setup

```bash
npm start
```

Open `http://localhost:3000`.

Create the first account to become the Admin. Create additional accounts in another browser/session; those users become Members and can be added to projects by the Admin.

## REST API

All authenticated routes require:

```http
Authorization: Bearer <token>
```

### Auth

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/me`

### Users

- `GET /api/users`
- `PATCH /api/users/role` Admin only

### Projects

- `GET /api/projects`
- `POST /api/projects` Admin only
- `PATCH /api/projects` Admin only

### Tasks

- `GET /api/tasks`
- `POST /api/tasks` Admin only
- `PATCH /api/tasks`

Members may only update task status. Admins may update task title, description, assignee, due date, and status.

### Dashboard

- `GET /api/dashboard`

## Data Relationships

- `users` own sessions and can be project members.
- `projects` have one owner and many members.
- `tasks` belong to one project and have one assignee.
- Task assignees must be members of the selected project.

## Railway Deployment

1. Push this repository to GitHub.
2. Create a new Railway project from the GitHub repo.
3. Railway will detect Node/Nixpacks and run `npm start`.
4. Add this environment variable in Railway:

```bash
TOKEN_SECRET=<strong-random-secret>
```

5. Deploy and open the Railway generated domain.

## Submission

- Live URL: `flowboard-production-d18e.up.railway.app`
- GitHub repo: `[TODO: add GitHub repository URL](https://github.com/tanishqtrivedi/FlowBoard)`

## Notes

The app stores data in `data/db.json`. This keeps the project dependency-free and simple to deploy. For long-term production use, replace the file-backed store with Railway PostgreSQL or MongoDB while keeping the existing REST API contracts.
