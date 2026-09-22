# Deployment Migration: SSH → SSM

## Summary

kube-man deployment has been migrated from SSH to AWS Systems Manager (SSM), eliminating the need for SSH keys and improving security posture.

## What Changed

### 1. **GitHub Actions Workflow** (`.github/workflows/deploy.yml`)

**Before (SSH):**
```bash
# 1. Upload files via tar over SSH pipe
tar czf - files | ssh user@host "tar xzf - -C /path && chmod +x script"

# 2. Run deployment script via SSH, piping ECR credentials
aws ecr get-login-password | ssh user@host "cd /path && ./deploy.sh"
```

**After (SSM):**
```bash
# 1. Upload files to S3
aws s3 cp files s3://bucket/prefix/

# 2. Send SSM command to EC2 instance
aws ssm send-command --instance-ids i-xxx --document-name "AWS-RunShellScript" \
  --parameters commands=["cd /tmp && aws s3 sync ... && ./deploy.sh"]

# 3. Poll for completion
aws ssm get-command-invocation --command-id xxx
```

### 2. **Deployment Script** (`deploy.sh`)

**Before:**
```bash
# Received ECR login password via stdin from SSH
docker login --username AWS --password-stdin "$ECR_REGISTRY" < stdin
```

**After:**
```bash
# Gets ECR credentials using AWS CLI (works with EC2 IAM role)
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"
```

### 3. **GitHub Actions Secrets**

| Before | After |
|--------|-------|
| `DEPLOY_SSH_KEY` | ❌ Removed |
| `DEPLOY_KNOWN_HOSTS` | ❌ Removed |
| `DEPLOY_USER` | ❌ Removed |
| `DEPLOY_HOST` | ❌ Removed |
| - | ✅ `EC2_INSTANCE_ID` (new) |

## Benefits

| Aspect | SSH | SSM |
|--------|-----|-----|
| **Key Management** | Requires SSH keys stored as secrets | No keys, uses IAM roles |
| **Audit Trail** | Limited logging | Full CloudTrail logging |
| **Network** | Requires SSH port (22) open | No open ports needed |
| **Private Subnets** | Needs bastion host | Works natively |
| **Compliance** | Weaker posture | Better for SOC2/FedRAMP |
| **Scalability** | One-to-one SSH connections | Can target multiple instances |

## Setup Checklist

- [ ] **EC2 Instance**
  - [ ] Has `AmazonSSMManagedInstanceCore` IAM policy
  - [ ] SSM Agent is running and enabled
  - [ ] Has S3 read access to `maimons-infra/kubeman/*`
  - [ ] Has ECR access to pull images
  - [ ] AWS CLI is installed

- [ ] **GitHub Actions**
  - [ ] Set `EC2_INSTANCE_ID` secret in repo
  - [ ] Verify `maimons-infra-github-ssm` IAM role has OIDC trust for GitHub
  - [ ] Remove old SSH secrets: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_USER`, `DEPLOY_HOST`

- [ ] **AWS Account**
  - [ ] S3 bucket `maimons-infra` exists and has correct permissions
  - [ ] ECR repository `kubeman` exists
  - [ ] IAM OIDC provider configured for GitHub Actions

## Testing the Setup

### Quick Test

Push a commit to main and watch GitHub Actions:
```bash
git push origin main
gh run list  # Watch the workflow run
gh run view <run-id> --log  # View logs
```

### Manual Test (before pushing)

```bash
# Test SSM connectivity
aws ssm send-command \
  --instance-ids i-xxxxx \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=['echo TEST && date']" \
  --region eu-central-1

# Check status
aws ssm get-command-invocation \
  --command-id <id> \
  --instance-id i-xxxxx \
  --region eu-central-1
```

## Rollback (if needed)

If you need to rollback to SSH deployment:

1. Revert these commits
2. Restore the SSH deploy job in `.github/workflows/deploy.yml`
3. Restore the old `deploy.sh` that reads credentials from stdin
4. Re-add SSH secrets to GitHub Actions

However, we recommend staying with SSM—it's more secure and maintainable.

## Migration History

- **2026-09-23**: Migrated from SSH to SSM
  - Replaced `deploy.sh` stdin password input with AWS CLI
  - Updated GitHub Actions workflow to use SSM send-command
  - Added comprehensive setup documentation
  - No changes to build pipeline (tests + ECR push remain the same)

## References

- AWS Systems Manager: https://docs.aws.amazon.com/systems-manager/
- SSM Send Command: https://docs.aws.amazon.com/systems-manager/latest/userguide/documents-command-run-command.html
- GitHub Actions OIDC: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
