# ADR 0001: Fork, Do Not Rewrite

Status: accepted

## Context

The repository already contains a working V1 bridge, workspace policy, tunnel handling, and token storage model.

## Decision

V2 is a fork-and-migrate effort, not a clean rewrite.

## Consequences

- current security behavior stays the baseline
- migration work can be split into small PRs
- docs can describe future shape without implying current implementation
