# Maintenance Guide

This guide covers dependency updates and ongoing maintenance for the SUI Payment Agent.

## Current Versions

- **SUI SDK:** testnet-v1.37.3
- **AWS CDK:** 2.150.0
- **Rust:** 1.75+ (stable)
- **Node.js:** 18.x+
- **Lambda Runtime:** provided.al2023

## Dependency Update Schedule

### Critical (Check Monthly)
- **SUI SDK** - Network upgrades and breaking changes
  - Monitor: https://github.com/MystenLabs/sui/releases
  - Update when: Moving to mainnet or major testnet upgrades

### Important (Check Quarterly)
- **AWS CDK** - New features and deprecation fixes
  - Monitor: https://github.com/aws/aws-cdk/releases
  - Update when: Deprecation warnings appear

### As Needed
- **Rust AWS SDK** - Security patches
- **Cargo dependencies** - Security advisories

## How to Check for Updates

### Check SUI SDK Version
```bash
# View current version
grep "sui-sdk" shared/Cargo.toml

# Check latest releases
curl -s https://api.github.com/repos/MystenLabs/sui/releases/latest | grep tag_name
```

### Check AWS CDK Version
```bash
npm outdated
```

### Check Rust Dependencies
```bash
cargo outdated
```

## Update Process

### 1. Update SUI SDK

**Edit all Cargo.toml files:**
```toml
# Change from:
sui-sdk = { git = "https://github.com/MystenLabs/sui", tag = "testnet-v1.37.3" }

# To:
sui-sdk = { git = "https://github.com/MystenLabs/sui", tag = "testnet-v1.40.0" }
```

**Files to update:**
- `shared/Cargo.toml`
- `invoice-generator/Cargo.toml`
- `invoice-manager/Cargo.toml`
- `watcher/Cargo.toml`
- `sweeper/Cargo.toml`

**Test:**
```bash
./build.sh
npm run test-payment
```

### 2. Update AWS CDK

```bash
npm update aws-cdk-lib aws-cdk
npm run deploy
```

### 3. Update Rust Dependencies

```bash
cargo update
./build.sh
npm run deploy
```

## Breaking Changes to Watch For

### SUI Network Changes

**Testnet → Mainnet Migration:**
1. Update RPC endpoint in `.env`:
   ```bash
   SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
   SUI_NETWORK=mainnet
   ```

2. Update treasury address to mainnet wallet

3. Generate new mainnet mnemonic:
   ```bash
   npm run setup-secrets
   ```

4. Redeploy:
   ```bash
   npm run deploy
   ```

**Gas Price Changes:**
- Monitor SUI gas costs
- May need to adjust reserve amounts in sweeper logic

**Transaction Format Changes:**
- Check SUI SDK migration guides
- Test thoroughly on testnet first

### AWS Changes

**CDK v3 (Future):**
- Major version upgrade (not released yet)
- Will require code changes
- Follow AWS migration guide when available

**Lambda Runtime Updates:**
- AL2023 is current and stable
- AWS will announce deprecations 12+ months in advance

**API Gateway Changes:**
- Rare, usually backward compatible
- Monitor AWS service announcements

## Security Updates

### Automated Monitoring

**GitHub Dependabot (Recommended):**
1. Enable Dependabot in repository settings
2. Automatically creates PRs for security updates
3. Review and merge security patches promptly

### Manual Monitoring

**Check for vulnerabilities:**
```bash
# Rust dependencies
cargo audit

# NPM dependencies
npm audit
```

**Fix vulnerabilities:**
```bash
# Rust
cargo update

# NPM
npm audit fix
```

## Testing After Updates

### Minimal Testing
```bash
# Build
./build.sh

# Deploy
npm run deploy

# Test invoice creation
npm run test-payment
```

### Comprehensive Testing
1. Create invoice
2. Fund address via faucet
3. Wait for watcher detection (1-2 minutes)
4. Verify sweep to treasury
5. Check CloudWatch logs for errors
6. Test invoice management endpoints

## Known Issues

### SUI Testnet Resets
- **Issue:** Testnet resets periodically, losing all data
- **Impact:** Treasury balance resets to zero
- **Solution:** Expected behavior, refund via faucet

### AWS CDK Deprecation Warnings
- **Issue:** `logRetention` deprecation warnings
- **Impact:** None (warnings only, not breaking)
- **Solution:** Will be fixed in future CDK update

### Cargo Lambda Build
- **Issue:** Must build packages separately
- **Impact:** None (handled by build.sh)
- **Solution:** Already implemented in build script

## Rollback Procedure

If an update breaks the system:

```bash
# 1. Revert code changes
git revert HEAD

# 2. Rebuild
./build.sh

# 3. Redeploy
npm run deploy

# 4. Verify
npm run test-payment
```

## Support Resources

### SUI
- **Documentation:** https://docs.sui.io
- **Discord:** https://discord.gg/sui
- **GitHub:** https://github.com/MystenLabs/sui

### AWS
- **CDK Documentation:** https://docs.aws.amazon.com/cdk/
- **CDK Issues:** https://github.com/aws/aws-cdk/issues
- **AWS Support:** https://console.aws.amazon.com/support/

### Community
- **Issues:** Open GitHub issue in this repository
- **Discussions:** Use GitHub Discussions for questions

## Maintenance Checklist

### Monthly
- [ ] Check SUI SDK releases
- [ ] Review CloudWatch logs for errors
- [ ] Verify system is operational

### Quarterly
- [ ] Update AWS CDK
- [ ] Update Rust dependencies
- [ ] Run security audit (cargo audit, npm audit)
- [ ] Review and rotate API keys

### Annually
- [ ] Review and update documentation
- [ ] Test disaster recovery (redeploy from scratch)
- [ ] Review AWS costs and optimize

## Version History

| Date | SUI SDK | AWS CDK | Notes |
|------|---------|---------|-------|
| 2026-02-22 | testnet-v1.37.3 | 2.150.0 | Initial release |

Update this table when performing major version updates.
