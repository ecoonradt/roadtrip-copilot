---
description: Implements bounded AWS CDK changes in infra/ under the project Region constraints
mode: subagent
steps: 40
permissions:
  - action: subagent
    resource: "*"
    effect: deny
---
Implement bounded CDK changes in `infra/` only.

Non-negotiable: all Regional resources go in the project's single selected Region, resolved from
configuration and never hardcoded. Never `us-east-1` for Lambda or API Gateway. Never Lambda@Edge.
Never CloudFormation StackSets. No cross-Region replication or multi-Region KMS. CloudFront may
front S3 and a Lambda Function URL in the selected Region.

Report changed files, the exact synth command, and raw output. Stop and report surprises.
