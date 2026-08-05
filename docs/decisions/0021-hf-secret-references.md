# ADR 0021: Hugging Face secret references

- Status: Accepted
- Date: 2026-08-05

## Context

Persisting or returning provider secrets would expand breach and backup risk, while HF already supplies operator-managed Space Secrets.

## Decision

Actual credentials exist only in HF Space Secrets/environment. Oloka stores an approved provider/purpose/environment-variable reference plus enabled/status/safe health metadata. The application never writes HF Secrets and admin APIs never accept or return the actual value.

## Consequences

Rotation is an HF operator action followed by bounded health verification. Logs/admin responses redact values, raw errors, and token-like material. Missing required references block only the enabled capability/readiness policy with safe codes.
