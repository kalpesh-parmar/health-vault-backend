# Health Vault Backend

<<<<<<< HEAD
Production-ready Node.js backend using Express, PostgreSQL, pgvector, and Drizzle ORM.
=======
Production-ready Node.js backend using Express, PostgreSQL, and pgvector.

> > > > > > > migrate-old-repo

## Architecture

The code follows strict clean architecture:

- `controllers`: request and response only
- `services`: validation and business logic
- `repositories`: raw `pg` database queries
- `middlewares`: auth, validation, rate limiting, error handling
- `resources/emailTemplates`: shared base email template and partial templates

## Security

- bcrypt password hashing
- JWT access and refresh tokens
- Helmet headers
- Express rate limiter
- Login and OTP attempt blocking with `MAX_LOGIN_ATTEMPTS`
- `USER_STATUS`: `ACTIVE`, `BLOCKED`, `INACTIVE`

## Environment

Copy `.env.example` to `.env` and configure:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/health_vault
JWT_SECRET=replace-with-a-long-random-secret
MAX_LOGIN_ATTEMPTS=3
```

## AI Document Flow

<<<<<<< HEAD
Drizzle schema is in `src/models`.

# Run migrations with your deployment migration runner or Drizzle Kit workflow.

The document intelligence flow accepts PDFs only. Selectable PDFs are extracted
with PyMuPDF first; scanned PDFs fall back to the singleton AI service inside
`ai-service`.

> > > > > > > migrate-old-repo

## AI Document Flow

The document intelligence flow accepts PDFs only. Selectable PDFs are extracted
with PyMuPDF first; scanned PDFs fall back to the singleton AI service inside
`ai-service`.

## Scripts

```bash
npm run dev
npm start
npm run lint
npm run format:check
npm test
```

Swagger is available at `/swagger-ui`.

## Email Templates

All templates use `src/resources/emailTemplates/baseTemplate.html`.

Included templates:

- `forgotPassword.html`
- `otpVerification.html`
- `resetPasswordSuccess.html`
- `accountBlocked.html`

## Commit Format

Commitlint accepts:

- `feat: new feature`
- `fix: bug fix`
- `refactor: code improvement`
