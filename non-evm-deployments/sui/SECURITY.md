# Security Policy

## Overview

This document outlines the security model, threat analysis, and best practices for the SUI Payment Agent system. This is a reference implementation designed for educational purposes and low-to-medium value transactions on testnet.

## Security Model

### Architecture Security

**Defense in Depth:**
- API Gateway with API key authentication
- Lambda function isolation (separate IAM roles)
- Secrets Manager encryption at rest (AWS KMS)
- DynamoDB encryption at rest
- Point-in-Time Recovery (35-day restore window)
- CloudWatch audit logging

**Trust Boundaries:**
1. **Public Internet → API Gateway**: API key required
2. **API Gateway → Lambda**: IAM role authorization
3. **Lambda → AWS Services**: Least-privilege IAM policies
4. **Lambda → SUI Network**: Read-only RPC calls (watcher), signed transactions (sweeper)

### Wallet Security

**Invoice Addresses (Hot Wallets):**
- Generated from BIP39 mnemonic using BIP44 path `m/44'/784'/0'/0'/x'`
- Private keys derived in-memory, never persisted
- Mnemonic stored in AWS Secrets Manager (encrypted with KMS)
- Funds automatically swept after detection (minimize exposure window)
- Each address used once (no reuse)

**Treasury Address (Cold Wallet):**
- **Production Recommendation**: Hardware wallet (Ledger, Trezor)
- Only public address stored in AWS (no private key)
- Receives all swept funds
- User maintains full control offline

**Key Rotation:**
- Invoice mnemonic: Rotate by generating new mnemonic and redeploying
- API keys: Rotate via AWS API Gateway console
- Treasury address: Change via environment variable and redeploy

## Threat Model

### In-Scope Threats

#### 1. API Key Compromise
**Risk**: Unauthorized invoice creation  
**Impact**: Medium - Attacker can create invoices but cannot steal funds  
**Mitigations**:
- API key rotation capability
- CloudWatch logging of all API calls
- Rate limiting via API Gateway
- Monitor for unusual invoice creation patterns

#### 2. Mnemonic Exposure
**Risk**: Invoice wallet private keys compromised  
**Impact**: High - Attacker can steal funds from invoice addresses  
**Mitigations**:
- Secrets Manager encryption at rest (KMS)
- IAM policies restrict access to Lambda execution roles only
- Automatic fund sweeping (minimize exposure window)
- Funds only held temporarily in invoice addresses

#### 3. Lambda Function Compromise
**Risk**: Malicious code execution in Lambda environment  
**Impact**: High - Could access secrets, modify invoices, or redirect funds  
**Mitigations**:
- Immutable Lambda deployments (versioned)
- IAM least-privilege policies
- CloudWatch logging for audit trail
- Code review and testing before deployment
- No external dependencies in sweeper (minimize supply chain risk)

#### 4. DynamoDB Data Tampering
**Risk**: Invoice status manipulation  
**Impact**: Medium - Could mark unpaid invoices as paid  
**Mitigations**:
- IAM policies restrict write access to Lambda functions only
- Point-in-Time Recovery (35-day restore)
- CloudWatch logs for audit trail
- Watcher validates on-chain balance before marking paid

#### 5. Replay Attacks
**Risk**: Reusing old payment detection to mark invoice as paid  
**Impact**: Low - Watcher checks current balance, not transaction history  
**Mitigations**:
- Balance-based detection (not transaction-based)
- Invoice marked paid only when balance ≥ amount
- Automatic sweeping prevents balance reuse

#### 6. Token Spoofing
**Risk**: Fake tokens sent to invoice address  
**Impact**: Low - Whitelist prevents acceptance  
**Mitigations**:
- Token whitelist validation in invoice-generator
- Only whitelisted token addresses accepted
- Watcher ignores non-whitelisted tokens

### Out-of-Scope Threats

#### 1. AWS Account Compromise
**Risk**: Full AWS account access  
**Impact**: Critical - Complete system compromise  
**Mitigation**: Outside system scope - use AWS security best practices:
- Enable MFA on root account
- Use IAM roles, not root credentials
- Enable CloudTrail
- Use AWS Organizations for account isolation

#### 2. SUI Network Attacks
**Risk**: 51% attack, consensus failure, RPC node compromise  
**Impact**: Critical - Could affect payment detection or sweeping  
**Mitigation**: Outside system scope - inherent blockchain risk

#### 3. Hardware Wallet Compromise
**Risk**: Treasury wallet private key stolen  
**Impact**: Critical - All accumulated funds stolen  
**Mitigation**: Outside system scope - user responsibility

#### 4. Social Engineering
**Risk**: Attacker tricks user into revealing credentials  
**Impact**: Varies by credential type  
**Mitigation**: Outside system scope - user training and awareness

## Production Deployment Recommendations

### For Low-Value Transactions (< $1,000/day)

**Current Implementation is Suitable:**
- ✅ Secrets Manager for mnemonic storage
- ✅ Automatic fund sweeping
- ✅ Hardware wallet for treasury
- ✅ API key authentication
- ✅ CloudWatch monitoring

**Additional Recommendations:**
1. Enable AWS WAF on API Gateway
2. Set up CloudWatch alarms for:
   - Failed sweep attempts
   - Unusual invoice creation volume
   - API error rates
3. Implement API rate limiting
4. Regular API key rotation (monthly)
5. Monitor treasury wallet balance

### For Medium-Value Transactions ($1,000-$10,000/day)

**All Low-Value Recommendations, Plus:**
1. Multi-region deployment for availability
2. DynamoDB global tables for redundancy
3. Enhanced CloudWatch dashboards
4. PagerDuty/SNS alerts for critical events
5. Regular security audits (quarterly)
6. Implement request signing (beyond API keys)
7. Consider AWS Shield for DDoS protection

### For High-Value Transactions (> $10,000/day)

**All Medium-Value Recommendations, Plus:**
1. **AWS CloudHSM for Ed25519 signing** (see KMS_PRODUCTION_NOTES.md)
   - Hardware-backed key storage
   - FIPS 140-2 Level 3 compliance
   - Cost: ~$3,000-4,000/month
2. Multi-signature treasury wallet
3. Manual approval workflow for large sweeps
4. Real-time fraud detection
5. Dedicated security team
6. Penetration testing (annual)
7. Bug bounty program
8. Compliance certifications (SOC 2, PCI-DSS if applicable)

## Known Limitations

### 1. Ed25519 Signing in Lambda Memory
**Issue**: Private keys derived in-memory during sweeping  
**Risk**: Memory dump could expose keys  
**Mitigation**: Automatic sweeping minimizes exposure window  
**Production Solution**: AWS CloudHSM (see KMS_PRODUCTION_NOTES.md)

### 2. API Key Authentication Only
**Issue**: API keys can be intercepted or leaked  
**Risk**: Unauthorized invoice creation  
**Mitigation**: CloudWatch logging, rate limiting  
**Production Solution**: Implement AWS Signature Version 4 or OAuth 2.0

### 3. Single-Region Deployment
**Issue**: Regional AWS outage affects availability  
**Risk**: Cannot create invoices or detect payments during outage  
**Mitigation**: Payments still arrive on-chain, processed after recovery  
**Production Solution**: Multi-region deployment with Route 53 failover

### 4. Hardcoded Token Whitelist
**Issue**: Adding tokens requires code change and redeployment  
**Risk**: Slow to respond to new token requirements  
**Mitigation**: Whitelist prevents unauthorized tokens  
**Production Solution**: DynamoDB-based dynamic whitelist

### 5. No Rate Limiting on Invoice Creation
**Issue**: API key holder can create unlimited invoices  
**Risk**: DynamoDB cost increase, potential abuse  
**Mitigation**: CloudWatch monitoring  
**Production Solution**: API Gateway usage plans with throttling

## Security Best Practices

### Development

1. **Never commit secrets to Git**
   - Use .env for local development
   - .env is in .gitignore
   - Use AWS Secrets Manager for production

2. **Review dependencies regularly**
   - Run `cargo audit` for Rust dependencies
   - Run `npm audit` for Node.js dependencies
   - Keep dependencies updated

3. **Test on testnet first**
   - Never deploy untested code to mainnet
   - Verify all payment flows end-to-end
   - Test failure scenarios

4. **Code review before deployment**
   - Review all changes to sweeper logic
   - Verify treasury address before deployment
   - Check IAM policy changes

### Operations

1. **Monitor CloudWatch logs daily**
   - Check for failed sweeps
   - Review API error rates
   - Monitor unusual patterns

2. **Rotate credentials regularly**
   - API keys: Monthly
   - Invoice mnemonic: Quarterly (requires redeployment)
   - AWS IAM credentials: Per AWS best practices

3. **Backup critical data**
   - DynamoDB PITR enabled (35-day restore)
   - Export invoice data regularly
   - Keep offline backup of mnemonic

4. **Test disaster recovery**
   - Practice stack redeployment
   - Verify backup restoration
   - Document recovery procedures

5. **Maintain audit trail**
   - CloudWatch logs retained 30 days
   - Export logs to S3 for long-term retention
   - Review logs during security incidents

## Incident Response

### If API Key is Compromised

1. **Immediate Actions:**
   - Disable compromised API key in AWS Console
   - Create new API key
   - Review CloudWatch logs for unauthorized usage
   - Check for suspicious invoices

2. **Investigation:**
   - Identify how key was compromised
   - Assess impact (number of unauthorized invoices)
   - Review all invoices created during exposure window

3. **Remediation:**
   - Update API key in authorized systems
   - Implement additional monitoring
   - Consider implementing request signing

### If Mnemonic is Compromised

1. **Immediate Actions:**
   - **CRITICAL**: Assume all invoice addresses are compromised
   - Stop creating new invoices immediately
   - Monitor existing invoice addresses for unauthorized sweeps

2. **Investigation:**
   - Identify how mnemonic was exposed
   - Check CloudWatch logs for unauthorized access
   - Review Secrets Manager access logs

3. **Remediation:**
   - Generate new mnemonic
   - Update Secrets Manager
   - Redeploy entire stack
   - Notify affected customers if funds were stolen

### If Treasury Wallet is Compromised

1. **Immediate Actions:**
   - **CRITICAL**: This is outside system scope
   - Contact hardware wallet manufacturer
   - Attempt to sweep remaining funds to new wallet
   - File police report if significant funds stolen

2. **Investigation:**
   - Determine how hardware wallet was compromised
   - Review all transactions from treasury wallet
   - Check for ongoing unauthorized activity

3. **Remediation:**
   - Generate new treasury wallet
   - Update environment variable
   - Redeploy stack
   - Implement additional security measures

## Reporting Security Vulnerabilities

If you discover a security vulnerability in this project:

1. **DO NOT** open a public GitHub issue
2. **DO NOT** disclose publicly until patched
3. Email security details to: [YOUR-EMAIL]
4. Include:
   - Description of vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

**Response Timeline:**
- Initial response: 48 hours
- Severity assessment: 1 week
- Fix development: 2-4 weeks (depending on severity)
- Public disclosure: After fix is deployed and users notified

## Compliance Considerations

### Data Privacy

**Personal Data Stored:**
- None - system does not collect customer personal information
- Invoice reference IDs are merchant-provided (not validated)
- No KYC/AML requirements in current implementation

**GDPR Considerations:**
- If deploying in EU, consider data residency requirements
- Implement data retention policies
- Provide data export/deletion capabilities

### Financial Regulations

**Current Status:**
- Reference implementation for educational purposes
- Not designed for regulated financial services
- No KYC/AML/CTF compliance

**Production Considerations:**
- Consult legal counsel before production deployment
- Implement KYC/AML if required by jurisdiction
- Consider money transmitter licensing requirements
- Implement transaction monitoring for suspicious activity

## Security Audit Checklist

Before production deployment, verify:

- [ ] Treasury address is hardware wallet
- [ ] API keys are rotated and secured
- [ ] CloudWatch alarms are configured
- [ ] DynamoDB PITR is enabled
- [ ] Secrets Manager encryption is enabled
- [ ] IAM policies follow least-privilege
- [ ] All Lambda functions have separate IAM roles
- [ ] CloudWatch logs are retained appropriately
- [ ] Backup and recovery procedures are documented
- [ ] Incident response plan is in place
- [ ] Security monitoring is active
- [ ] Dependencies are up to date
- [ ] Code has been reviewed
- [ ] End-to-end testing is complete
- [ ] Documentation is accurate

## Additional Resources

- [AWS Security Best Practices](https://aws.amazon.com/security/best-practices/)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [SUI Security Best Practices](https://docs.sui.io/guides/developer/advanced/security)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)

## License

This security policy is part of the SUI Payment Agent project and is licensed under MIT-0.

## Disclaimer

This is a reference implementation for educational purposes. The security measures described are appropriate for testnet and low-value transactions. Always conduct thorough security audits and consult security professionals before handling significant funds or deploying to production environments.
