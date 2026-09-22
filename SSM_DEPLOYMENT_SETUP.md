# kube-man SSM Deployment Setup

This document describes the setup for kube-man's AWS Systems Manager (SSM) deployment (migration from SSH).

## Overview

kube-man now deploys via AWS Systems Manager (SSM) instead of SSH. This provides:
- ✅ No SSH keys to manage
- ✅ Full CloudTrail audit logging
- ✅ Better security compliance
- ✅ No need for bastion hosts
- ✅ Works with private EC2 instances

## EC2 Instance Configuration

### 1. Verify SSM Agent

The EC2 instance must have SSM Agent installed and running:

```bash
# Check status
sudo systemctl status amazon-ssm-agent

# Enable and start (if not running)
sudo systemctl enable amazon-ssm-agent
sudo systemctl start amazon-ssm-agent
```

Most Amazon Linux 2 and Ubuntu AMIs have this pre-installed.

### 2. IAM Role Requirements

The EC2 instance's IAM role must have:

**Policy 1: SSM Management** (built-in)
- `AmazonSSMManagedInstanceCore` - Allows SSM Agent to communicate

**Policy 2: ECR Access**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "arn:aws:ecr:eu-central-1:236565801201:repository/kubeman"
    }
  ]
}
```

**Policy 3: S3 Access** (for deployment files)
```json
{
  "Effect": "Allow",
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::maimons-infra/kubeman/*"
}
```

**Policy 4: CloudWatch Logs** (optional, for debugging)
```json
{
  "Effect": "Allow",
  "Action": [
    "logs:CreateLogGroup",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "logs:DescribeLogStreams"
  ],
  "Resource": "arn:aws:logs:eu-central-1:236565801201:*"
}
```

### 3. Secrets Setup (Optional)

If kube-man needs runtime secrets, create an AWS Secrets Manager secret:

```bash
aws secretsmanager create-secret \
  --name kubeman/runtime \
  --secret-string '{"API_KEY":"value","DATABASE_URL":"..."}' \
  --region eu-central-1
```

Update the IAM role to grant access:
```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:eu-central-1:236565801201:secret:kubeman/*"
}
```

## GitHub Actions Setup

### 1. EC2 Instance ID Secret

Add the EC2 instance ID as a GitHub Actions secret:

In your repo settings: `Settings → Secrets and variables → Actions`

- **Secret name**: `EC2_INSTANCE_ID`
- **Value**: `i-1234567890abcdef0` (your instance ID)

### 2. AWS Credentials (IAM OIDC)

Ensure the GitHub Actions workflow can authenticate to AWS via OIDC:

The workflow uses:
```yaml
role-to-assume: arn:aws:iam::236565801201:role/maimons-infra-github-ssm
```

This role must have an OIDC trust relationship configured. If not already set up, see [AWS OIDC provider for GitHub Actions](https://docs.github.aws/latest/userguide/id_roles_providers_create_oidc.html).

## Deployment Flow

```
Push to main branch
    ↓
GitHub Actions: build-and-push
    ├─ Run tests
    ├─ Build Docker images (web + shell)
    ├─ Push to ECR
    └─ Trigger deploy job
        ↓
GitHub Actions: deploy
    ├─ Upload files to S3
    │   ├─ compose.yaml
    │   ├─ compose.prod.yml
    │   ├─ deploy.sh
    │   └─ docker/Caddyfile
    └─ Send SSM command to EC2 instance
        ├─ Download from S3
        ├─ Run deploy.sh
        ├─ Pull Docker images
        ├─ Restart docker-compose
        └─ Health check
```

## Deployment Artifacts

Uploaded to S3 during deployment:
- `s3://maimons-infra/kubeman/compose.yaml` - Main compose file
- `s3://maimons-infra/kubeman/compose.prod.yml` - Production overrides
- `s3://maimons-infra/kubeman/deploy.sh` - Deployment script
- `s3://maimons-infra/kubeman/Caddyfile` - Reverse proxy config

## Troubleshooting

### "No such file or directory" / "Instance not found"

Check that the instance ID secret is correct:
```bash
# In your repo:
gh secret list | grep EC2_INSTANCE_ID

# Or check AWS:
aws ec2 describe-instances --instance-ids i-xxxxx --region eu-central-1
```

### "Pending" status (never completes)

The SSM Agent isn't responding. Check:
1. Instance is running: `aws ec2 describe-instances --instance-ids i-xxxxx`
2. SSM Agent is running: SSH to instance and run `sudo systemctl status amazon-ssm-agent`
3. Instance has IAM role with `AmazonSSMManagedInstanceCore` policy

### "Failed to pull image"

1. Verify ECR repository exists: `aws ecr describe-repositories --repository-names kubeman`
2. Check IAM role has ECR permissions (see above)
3. Verify images were pushed: `aws ecr describe-images --repository-name kubeman`

### "Deploy script not found"

The S3 upload failed. Check:
1. IAM role has S3 permissions
2. S3 bucket exists: `aws s3 ls s3://maimons-infra/kubeman/`
3. Check GitHub Actions logs for upload step

### Docker compose fails

SSH to the instance and check:
```bash
cd /opt/kubeman
docker compose -f compose.yaml -f compose.prod.yml ps
docker compose logs
```

## Manual Deployment

If automated deployment fails, you can deploy manually:

```bash
# 1. SSH to instance
ssh ec2-user@your-instance

# 2. Download files
cd /opt/kubeman
aws s3 sync s3://maimons-infra/kubeman/ . --region eu-central-1

# 3. Deploy
export ECR_REGISTRY="236565801201.dkr.ecr.eu-central-1.amazonaws.com"
export IMAGE_TAG="<commit-sha>"  # From GitHub Actions log
export AWS_REGION="eu-central-1"
chmod +x deploy.sh
./deploy.sh
```

## Profile "maimon" Reference

The "maimon" profile refers to the AWS CLI profile and GitHub Actions setup. It uses:
- **AWS Account**: 236565801201
- **Region**: eu-central-1
- **IAM Role**: maimons-infra-github-ssm (for OIDC)
- **EC2 Instance**: Identified by EC2_INSTANCE_ID secret

## See Also

- `deploy.sh` - Deployment script that runs on EC2
- `.github/workflows/deploy.yml` - GitHub Actions workflow
- AWS Systems Manager docs: https://docs.aws.amazon.com/systems-manager/latest/userguide/
