# ADR-0009: Authenticated Amazon ECR Public Pulls for Container Builds

* **Date:** 2026-10-22
* **Status:** Accepted
* **Deciders:** Eric, DeepSeek V4.1 Flash
* **Related Work Package:** [WP-02-s3-itinerary-storage](../plan/active/WP-02-s3-itinerary-storage.md)

---

## 1. Context & Problem Statement
The Milestone 2 deployment (`Deploy Cloud Infrastructure & Web Studio`, run
[39787943376](https://github.com/ecoonradt/roadtrip-copilot/actions/runs/39787943376)) failed during the CDK asset
build of `FastifyApiFunction`, before CloudFormation was ever touched:

```
#3 [internal] load metadata for public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4
#3 ERROR: failed to copy: httpReadSeeker: failed open: unexpected status code
   https://public.ecr.aws/v2/awsguru/aws-lambda-adapter/manifests/sha256:e2653f7...: 429 Too Many Requests
   - Server message: toomanyrequests: Data limit exceeded
ERROR: failed to build: failed to solve: public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4:
   failed to resolve source metadata ... 429 Too Many Requests
```

`route-builder/Dockerfile` pulls every external image from `public.ecr.aws`:
`docker/library/node:20-slim` (builder + runtime) and `awsguru/aws-lambda-adapter:0.8.4`
(the AWS Lambda Web Adapter extension that provides response streaming for Fastify).

Amazon ECR Public documents that *unauthenticated* pullers are capped at **500 GB of data per
month**, "the max amount of data supported and isn't adjustable", while authenticated pulls have a
higher limit ([ECR Public service quotas](https://docs.aws.amazon.com/AmazonECR/latest/public/public-service-quotas.html)).
GitHub-hosted runners share a small pool of egress IP addresses across all tenants, so the anonymous
quota is consumed by unrelated workloads; when the runner's IP has exhausted it, every pull from
`public.ecr.aws` returns `429 toomanyrequests: Data limit exceeded` regardless of our own usage.
That is why Milestone 0 and Milestone 1 deployments succeeded while this one failed with no
repository change to the Dockerfile registry lines.

The CI deploy identity (`roadtrip-copilot-github-actions-deploy`) is intentionally least-privilege
(ADR-0006) and was granted only private-registry token access (`ecr:GetAuthorizationToken`), so it
had no way to authenticate to the public registry even though valid AWS credentials were present.

## 2. Decision Drivers
* **Remove a shared, non-adjustable external dependency from CI:** deployment success must not depend
  on a per-IP quota shared with unrelated GitHub Actions tenants.
* **Least privilege preserved:** the CI deployer must not gain broader ECR/ECR Public surface than the
  single token exchange required for image pulls.
* **Keep local/contributor workflows working:** a developer without `ecr-public` permissions must still
  be able to run `./scripts/deploy_cloud.sh`.
* **No new accounts, mirrors, or registries to operate:** the project deliberately avoids extra state
  (ADR-0003, ADR-0005).

## 3. Considered Options
* **Option A — Authenticate Docker to `public.ecr.aws` with an ECR Public token (AWS-recommended):**
  run `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`
  before the CDK asset build, and grant the CI deployer `ecr-public:GetAuthorizationToken` +
  `sts:GetServiceBearerToken`.
* **Option B — Mirror base images and the adapter into private ECR:** fully insulated from public
  quotas, but requires a mirror repository plus an out-of-band bootstrap/replication step for every
  deployer, and adds an image-refresh chore.
* **Option C — Retry-only mitigation:** re-run failed workflows and/or retry the build until a runner
  with unexhausted anonymous quota is assigned. Zero code, but non-deterministic and can still fail
  every attempt on a bad day.
* **Option D — Swap registries (Docker Hub, GHCR, vendored adapter binary):** replaces one shared
  anonymous quota with another (Docker Hub rate-limits anonymous pulls per IP too), or commits a
  multi-megabyte binary to git.

## 4. Decision Outcome
Chosen Option: **Option A**, because it is the AWS-documented remedy, requires two IAM actions and one
`docker login`, and keeps the build dependency footprint and repository state unchanged.

The login in `scripts/deploy_cloud.sh` is **best-effort**: if the token cannot be obtained (e.g. a
contributor whose local credentials lack `ecr-public` permissions), the script prints an actionable
warning with the underlying AWS CLI reason and continues with anonymous pulls instead of hard-failing.
This deliberately avoids a chicken-and-egg deadlock — the IAM grant itself is delivered by a stack
update that requires a container build, so the first deploy after this change may still run
unauthenticated while every subsequent one (including all CI runs) pulls with the raised limit.

### Verified against this project's account (2026-10-22)

These are measurements, not assumptions, because the project runs on the new AWS experience (Free
Plan) where service availability and SCP guardrails differ from a classic account:

| Question | Verification | Result |
| :--- | :--- | :--- |
| Is Amazon ECR Public usable on this Free Plan project account? | `freetier:GetAccountPlanState` → `accountPlanType: FREE`; the official Free Tier supported-services list explicitly includes **Amazon Elastic Container Registry Public**; live `ecr-public:GetAuthorizationToken` call from the account | Supported |
| Do the project's SCPs/RCPs block the token exchange? | Real `GetAuthorizationToken` call on the account succeeded; policy simulation with the proposed statement returns `allowed` for both actions | Not blocked |
| Is `us-east-1` really required? | `--region us-east-2` → `Could not connect to the endpoint URL`; `--region us-west-2` → `GetAuthorizationToken command is only supported in us-east-1`; `--region us-east-1` → success | Mandatory |
| Does it work with the assumed-role session credentials CI uses? | `aws configure export-credentials` shows `AWS_SESSION_TOKEN`; token exchange + `docker login` succeeded with those exact credentials | Works |
| Does the AWS CLI in CI have the `ecr-public` command? | AWS CLI v2 ships it; the script additionally probes `aws ecr-public help` and warns instead of failing if absent | Guarded |
| Does the failing image still exist as referenced? | Pulled `awsguru/aws-lambda-adapter:0.8.4`; digest `sha256:e2653f7…` matches the manifest in the CI error | Confirmed |

### Positive Consequences
* CI container builds no longer compete for the 500 GB/month anonymous quota shared by GitHub runners.
* Least privilege is preserved: the deployer gains exactly a public-registry token exchange, nothing
  that can push, delete, or read private registry contents beyond what it already had.
* Local deployments without ECR Public permissions keep working with a clear, self-diagnosing warning.

### Negative Consequences / Trade-offs
* The deploy identity can mint a registry-wide bearer token (`sts:GetServiceBearerToken` is
  unscoped by nature); it is short-lived (12 hours) and grants pull-only access to public images.
* `us-east-1` appears in the script even though the stack deploys to `us-east-2`. This is forced by
  the ECR Public API (see table above), creates no resources there, and the token is valid everywhere.
* The first deploy after this change may still run unauthenticated if the runner's egress IP has
  exhausted the anonymous quota, because the enabling IAM grant ships in that same deploy. Any later
  run — including a simple workflow re-run, which gets a fresh runner IP — pulls authenticated.
* Anonymous upstream failure remains possible for developers who skip authentication; the warning text
  names the exact IAM actions required to fix it.

## 5. Implementation Notes & Code Touchpoints
* **`scripts/deploy_cloud.sh`** — new step `2b` before the web-studio build and `cdk deploy`:
  a CLI capability probe, then
  `aws ecr-public get-login-password --region us-east-1` piped into
  `docker login --username AWS --password-stdin public.ecr.aws`. All failure paths warn with the
  underlying reason and continue under `set -euo pipefail`.
* **`infra/lib/roadtrip-cloud-stack.ts`** — `attachDeployPermissions` now adds
  `ecr-public:GetAuthorizationToken` and `sts:GetServiceBearerToken` to both the deploy role and the
  deploy user.
* **`infra/test/roadtrip-cloud-stack.test.ts`** — asserts the new policy statement is synthesized.
* **`.github/workflows/deploy.yml`** — unchanged; it already assumes the deploy role before invoking
  the script, so the token exchange uses the scoped CI identity.
