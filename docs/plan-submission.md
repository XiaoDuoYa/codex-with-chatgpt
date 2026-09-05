# Constrained Plan Submission

`submit_plan` is an optional MCP write action for ChatGPT Business, Enterprise, or Edu workspaces that support full MCP write actions. The bridge remains read-only by default. Existing OAuth grants do not gain `plan.write` automatically.

## Boundary

`submit_plan` can only create a new Markdown artifact in the server-owned plan inbox:

```text
plan-inbox:/<workspace-id>/<project>/<staged-digest>/<server-generated-name>.md
```

It cannot:

- write to the connected workspace;
- choose a destination path or filename;
- overwrite, edit, or delete a prior artifact;
- execute commands or change Git;
- reuse an authorization.

The receipt uses that logical alias so local home paths are not exposed to the
model. On disk it maps below `<C2C_STATE_DIR>/plan-inbox/`. The inbox and plan
files are owner-only (`0700` directories and `0600` files).

## Prerequisites

Plan submission currently fails closed on Windows because restrictive file DACLs are not yet enforced. The nine workspace tools remain available there in read-only mode.

1. Stage the project with a producer that implements the exact [Staging Manifest v2](staging-manifest-v2.md) contract.
2. Reconnect the ChatGPT app and explicitly grant `plan.write`. Omitting the requested scope keeps the default read-only grant.
3. Confirm the write in ChatGPT when it asks to call `submit_plan`.

## Create a one-time authorization

Run this against the exact connected staging root:

```bash
c2c authorize-plan \
  --workspace /absolute/path/to/C2C-Projects \
  --project exact-project-name \
  --digest exact-64-character-staging-digest \
  --json
```

The command starts or reuses the local bridge, verifies the manifest and every staged file, then returns an authorization that:

- is bound to the exact project and digest;
- expires after 10 minutes by default;
- exists only in bridge memory;
- is consumed by the first submission attempt.

Copy the returned `authorization` value into the ChatGPT prompt. Treat it as a short-lived capability and do not log it.

## Required tool input

ChatGPT calls `submit_plan` with:

- `project`: exact staged project directory name;
- `staged_digest`: exact approved digest;
- `authorization`: fresh one-time value;
- `content`: complete plan text.

The content must be UTF-8, at most 256 KiB, and contain these sections exactly once in this order:

```text
FILES_USED:
ASSUMPTIONS:
PLAN:
OPEN_QUESTIONS:
```

Every `FILES_USED` bullet must name a unique file in the approved manifest. Before writing, the server rechecks the manifest digest, exact file set, file sizes, file hashes, and symlink policy.

The four section labels are reserved framing lines. Do not repeat a label as an exact column-zero line inside a section or code block.

## Receipt and review

A successful call returns the exact inbox path, byte count, SHA-256, project, staged digest, and creation time. Read back that exact file and independently verify its SHA-256 before moving any plan into a canonical project.

A failed submission consumes the authorization. Create a new authorization after fixing the failure.
